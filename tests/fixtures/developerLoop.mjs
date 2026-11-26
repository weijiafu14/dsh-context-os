import { createBuildRequire, dshLayout } from '../../scripts/dshSource.mjs';
/** Build an isolated candidate; never edit the pinned source or replace the installed loop. */
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function candidateLoop() {
  const layout = dshLayout();
  const source = layout.root;
  const buildRequire = createBuildRequire(projectRoot, source);
  const { build } = buildRequire('esbuild');
  const root = await mkdtemp(join(tmpdir(), 'connector-native-admission-'));

  const loopTarget = join(source, layout.targets['@deepseek-ai/dsh-agent-loop']);
  const llmTarget = join(source, layout.targets['@deepseek-ai/dsh-llm']);
  const promptTarget = join(source, layout.targets['@deepseek-ai/dsh-system-prompt']);

  const original = await readFile(loopTarget, 'utf8');
  if (!original.includes('this.loopCtx.tools.resolve(')) {
    throw new Error('Pinned agent-loop resolve boundary not found');
  }

  let candidate = original
    .replace(
      'const toolSet = await this.loopCtx.tools.resolve({',
      `await this.dispatch.serial("agent/prepare-step", { messages: Object.freeze([...claimed]), ...position, signal, modelSelection: selection });
      signal.throwIfAborted();
      const toolSet = await this.loopCtx.tools.resolve({`,
    )
    .replace(
      /return \{\s*\.\.\.decision,\s*assembly,\s*selection,\s*toolSet\s*\};/,
      'return { ...decision, ...(assembly.admission ?? {}), assembly, selection, toolSet };',
    )
    .replaceAll(
      'const context = this.runtimeContext.project(joinContextSections(sections), sections);',
      'const context = assembly.admission ? undefined : this.runtimeContext.project(joinContextSections(sections), sections);',
    )
    .replace(
      /(const \{ config, preparedCall \} = await this\.prepareRequest\([^\n]+\n)(\s*const (?:sections = renderContextSections\(|currentContext = ))/,
      `$1      signal.throwIfAborted();
      if (firstAttempt) for (const { seq, message } of decision.messageReplacements ?? []) {
        const intent = { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] };
        if (message.role === "user") this.session.append("user/message", message, intent);
        else this.session.append("developer/message", { turn, step, message }, intent);
      }
$2`,
    )
    .replace(
      /inHistory:\s*preparedCall\?\.systemPromptUpdate\s*===\s*["']in-history["'],/,
      'inHistory: !assembly.admission && preparedCall?.systemPromptUpdate === "in-history",',
    );

  if (candidate.includes('if (firstAttempt) for (const message of decision.messages)')) {
    candidate = candidate.replace(
      'if (firstAttempt) for (const message of decision.messages)',
      `if (firstAttempt) for (const message of decision.developerMessages ?? []) {
        this.session.append("developer/message", { turn, step, message }, { surfaceOp: "append" });
      }
      if (firstAttempt) for (const message of decision.messages)`,
    );
  } else if (candidate.includes('for (const message of decision.messages) {')) {
    candidate = candidate.replace(
      'for (const message of decision.messages) {',
      `for (const message of decision.developerMessages ?? []) {
        this.session.append("developer/message", { turn, step, message }, { surfaceOp: "append" });
      }
      for (const message of decision.messages) {`,
    );
  } else {
    throw new Error('Pinned message admission loop changed');
  }

  if (
    !candidate.includes('agent/prepare-step') ||
    !candidate.includes('...(assembly.admission ?? {})') ||
    !candidate.includes('decision.messageReplacements') ||
    !candidate.includes('decision.developerMessages')
  ) {
    throw new Error('Pinned preparation boundary changed');
  }

  const contentOriginal = await readFile(llmTarget, 'utf8');
  const preserveInstructions = `function withoutDeveloperMessages(messages) {
  const retained = messages.flatMap((message) => {
    if (message.role !== "developer") return [message];
    const content = message.content.filter((block) => block.type !== "tool-addition" && block.type !== "tool-removal");
    return content.length ? [content.length === message.content.length ? message : { ...message, content }] : [];
  });
  return retained.length === messages.length && retained.every((message, index) => message === messages[index]) ? messages : retained;
}`;
  const contentCandidate = contentOriginal
    .replace(/function withoutDeveloperMessages\(messages\)\s*\{[\s\S]*?\n\}/, preserveInstructions)
    .replace(
      /if \(!updateIds\.has\(message\.id\)\)\s*continue;/,
      'if (!updateIds.has(message.id)) { projectedMessages.push(...withoutDeveloperMessages([message])); continue; }',
    );
  if (
    contentCandidate === contentOriginal ||
    !contentCandidate.includes('projectedMessages.push(...withoutDeveloperMessages([message]))')
  ) {
    throw new Error('Pinned tool-update projection changed');
  }

  const promptOriginal = await readFile(promptTarget, 'utf8');
  const promptCandidate = promptOriginal
    .replace(
      /refreshContext\(assembly,\s*context\s*=\s*\{\}\)\s*\{/,
      'refreshContext(assembly, context = {}) {\n    if (assembly.admission) return assembly;',
    )
    .replace(
      /if \(completeSection === (?:void 0|undefined) && !runtimeContextSuppressed\)/,
      'if (transformed.admission) return { ...transformed, tools: transformed.admission.tools, sections: transformed.admission.sections, contexts: transformed.admission.contexts };\n    if (completeSection === undefined && !runtimeContextSuppressed)',
    );
  if (
    !promptCandidate.includes('if (assembly.admission) return assembly;') ||
    !promptCandidate.includes('tools: transformed.admission.tools')
  ) {
    throw new Error('Pinned prompt admission changed');
  }

  try {
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const compile = (entry, contents, outfile) =>
      build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'warning',
        plugins: [
          {
            name: 'isolated-native-candidate',
            setup(b) {
              b.onLoad({ filter: /.*/ }, (args) =>
                args.path === entry
                  ? { contents, loader: 'js', resolveDir: dirname(entry) }
                  : undefined,
              );
              b.onResolve({ filter: /^(@|[a-z])/ }, (args) => {
                if (args.path.startsWith('node:')) return { path: args.path, external: true };
                return { path: createRequire(args.importer).resolve(args.path), external: true };
              });
            },
          },
        ],
      });

    await compile(loopTarget, candidate, join(root, 'lib/loop.mjs'));
    await compile(llmTarget, contentCandidate, join(root, 'lib/llm.mjs'));
    await compile(promptTarget, promptCandidate, join(root, 'lib/prompt.mjs'));
    await writeFile(join(root, 'candidate-agent.ts'), candidate);
    const module = await import(pathToFileURL(join(root, 'lib/loop.mjs')).href);
    const llm = await import(pathToFileURL(join(root, 'lib/llm.mjs')).href);
    return {
      loop: module.default,
      llm: llm.default,
      projectToolUpdates: llm.projectToolUpdates,
      layout,
      root,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
