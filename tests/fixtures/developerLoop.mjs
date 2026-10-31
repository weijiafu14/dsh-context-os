import { dshSource } from '../../scripts/dshSource.mjs';
/** Build an isolated candidate; never edit the pinned source or replace the installed loop. */
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function candidateLoop() {
  const source = dshSource();
  const buildRequire = createRequire(join(source, 'node_modules/.pnpm/node_modules/package.json'));
  const { build } = buildRequire('esbuild');
  const root = await mkdtemp(join(tmpdir(), 'connector-native-admission-'));
  // Use the TypeScript compiler output: upstream builds inline Cordis const enums here.
  const target = join(source, 'packages/core/agent-loop/lib/types/agent.js');
  const original = await readFile(target, 'utf8');
  const before = 'for (const message of decision.messages) {';
  if (original.split(before).length !== 2) throw new Error('Pinned admission implementation changed');
  const candidate = original.replace(before, `for (const message of decision.developerMessages ?? []) {
          this.session.append('developer/message', { turn, step, message }, { surfaceOp: 'append' });
        }
        for (const message of decision.messages) {`).replace(
    'const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal });',
    `await this.dispatch.serial('agent/prepare-step', { messages: Object.freeze([...claimed]), ...position, signal, modelSelection: selection });
        signal.throwIfAborted();
        const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal });`).replace(
    'return { ...decision, assembly, selection, toolSet };',
    'return { ...decision, ...(assembly.admission ?? {}), assembly, selection, toolSet };').replace(
    'const sections = renderContextSections(currentContext);',
    `signal.throwIfAborted();
      if (firstAttempt) for (const { seq, message } of decision.messageReplacements ?? []) {
        const intent = { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] };
        if (message.role === 'user') this.session.append('user/message', message, intent);
        else this.session.append('developer/message', { turn, step, message }, intent);
      }
      const sections = renderContextSections(currentContext);`).replace(
    "inHistory: preparedCall?.systemPromptUpdate === 'in-history',",
    "inHistory: !assembly.admission && preparedCall?.systemPromptUpdate === 'in-history',").replaceAll(
    'const context = this.runtimeContext.project(joinContextSections(sections), sections);',
    'const context = assembly.admission ? undefined : this.runtimeContext.project(joinContextSections(sections), sections);');
  if (!candidate.includes("this.dispatch.serial('agent/prepare-step'") || !candidate.includes('...(assembly.admission ?? {})')) throw new Error('Pinned preparation boundary changed');
  const contentTarget = join(source, 'packages/llm/llm/lib/types/content.js');
  const contentOriginal = await readFile(contentTarget, 'utf8');
  const preserveInstructions = `function withoutDeveloperMessages(messages) {
    const retained = messages.flatMap(message => {
      if (message.role !== 'developer') return [message];
      const content = message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal');
      return content.length ? [content.length === message.content.length ? message : { ...message, content }] : [];
    });
    return retained.length === messages.length && retained.every((message, index) => message === messages[index]) ? messages : retained;
}`;
  const contentCandidate = contentOriginal.replace(/function withoutDeveloperMessages\(messages\) \{[\s\S]*?\n\}/, preserveInstructions)
    .replace('if (!updateIds.has(message.id))\n            continue;', `if (!updateIds.has(message.id)) {
          projectedMessages.push(...withoutDeveloperMessages([message]));
          continue;
        }`);
  if (contentCandidate === contentOriginal || !contentCandidate.includes('projectedMessages.push(...withoutDeveloperMessages([message]))')) throw new Error('Pinned tool-update projection changed');
  const promptTarget = join(source, 'packages/core/system-prompt/lib/types/index.js');
  const promptOriginal = await readFile(promptTarget, 'utf8');
  const promptCandidate = promptOriginal.replace('refreshContext(assembly, context = {}) {', 'refreshContext(assembly, context = {}) {\n        if (assembly.admission) return assembly;')
    .replace('if (completeSection === undefined && !runtimeContextSuppressed)', 'if (transformed.admission) return { ...transformed, tools: transformed.admission.tools, sections: transformed.admission.sections, contexts: transformed.admission.contexts };\n        if (completeSection === undefined && !runtimeContextSuppressed)');
  if (!promptCandidate.includes('if (assembly.admission) return assembly;') || !promptCandidate.includes('tools: transformed.admission.tools')) throw new Error('Pinned prompt admission changed');
  try {
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'package.json'), await readFile(join(source, 'packages/llm/llm/package.json')));
    const compile = (entry, outfile) => build({ entryPoints: [entry], outfile,
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', plugins: [{ name: 'isolated-native-candidate', setup(build) {
        build.onLoad({ filter: /\/agent\.js$/ }, args => args.path === target ? { contents: candidate, loader: 'js', resolveDir: resolve(target, '..') } : undefined);
        build.onLoad({ filter: /\/content\.js$/ }, args => args.path === contentTarget ? { contents: contentCandidate, loader: 'js', resolveDir: resolve(contentTarget, '..') } : undefined);
        build.onLoad({ filter: /\/index\.js$/ }, args => args.path === promptTarget ? { contents: promptCandidate, loader: 'js', resolveDir: resolve(promptTarget, '..') } : undefined);
        build.onResolve({ filter: /^(@|[a-z])/ }, args => {
          if (args.path.startsWith('node:')) return { path: args.path, external: true };
          return { path: createRequire(args.importer).resolve(args.path), external: true };
        });
      } }],
    });
    await compile(join(source, 'packages/core/agent-loop/lib/types/index.js'), join(root, 'lib/loop.mjs'));
    await compile(join(source, 'packages/llm/llm/lib/types/index.js'), join(root, 'lib/llm.mjs'));
    await compile(promptTarget, join(root, 'lib/prompt.mjs'));
    await writeFile(join(root, 'candidate-agent.ts'), candidate);
    const module = await import(pathToFileURL(join(root, 'lib/loop.mjs')).href);
    const llm = await import(pathToFileURL(join(root, 'lib/llm.mjs')).href);
    return { loop: module.default, llm: llm.default, projectToolUpdates: llm.projectToolUpdates, root, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
