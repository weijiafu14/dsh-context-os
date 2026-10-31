import { dshSource } from './dshSource.mjs';
/** Produce a reviewable upstream source patch without editing the pinned installation. */
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = dshSource();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-developer-proposal-'));
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Pinned source changed near ${before.slice(0, 70)}`);
  return text.replace(before, after);
}
const edits = {
  'packages/core/agent/src/runtime-types.ts': text => replaceOnce(replaceOnce(replaceOnce(text,
    'AgentCancelCause, Session, SessionSeq, UserMessage', 'AgentCancelCause, DeveloperMessage, Session, SessionSeq, UserMessage'),
    '    messages: UserMessage[]\n', '    messages: UserMessage[]\n    /** Staged developer context, admitted with this step after cancellation and request preparation. */\n    developerMessages?: readonly DeveloperMessage[]\n    messageReplacements?: readonly { seq: SessionSeq; message: DeveloperMessage | UserMessage }[]\n'),
    '    // ---- the machine\'s extension points ----', `    // ---- the machine's extension points ----
    /**
     * Await scoped context preparation before capability admission and prompt assembly.
     * Input is read-only; model selection is already captured. Handlers must observe signal.
     * @mode serial
     */
    'agent/prepare-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: readonly UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }): void | Promise<void>`),
  'packages/core/agent-loop/src/agent.ts': text => {
    text = replaceOnce(text, 'EpochHeader, RequestContext, Session,', 'DeveloperMessage, EpochHeader, RequestContext, Session,');
    text = replaceOnce(text, '    messages: UserMessage[]\n', '    messages: UserMessage[]\n    developerMessages?: readonly DeveloperMessage[]\n    messageReplacements?: readonly { seq: SessionSeq; message: DeveloperMessage | UserMessage }[]\n');
    text = replaceOnce(text, '    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })',
      `    await this.dispatch.serial('agent/prepare-step', { messages: Object.freeze([...claimed]), ...position, signal, modelSelection: selection })
    signal.throwIfAborted()
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })`);
    text = replaceOnce(text, '      return { ...decision, assembly, selection, toolSet }', '      return { ...decision, ...(assembly.admission ?? {}), assembly, selection, toolSet }');
    text = replaceOnce(text, '      const sections = renderContextSections(currentContext)',
      `      signal.throwIfAborted()
      if (firstAttempt) for (const { seq, message } of decision.messageReplacements ?? []) {
        const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
        if (message.role === 'user') this.session.append('user/message', message, intent)
        else this.session.append('developer/message', { turn, step, message }, intent)
      }
      const sections = renderContextSections(currentContext)`)
    text = replaceOnce(text, "        inHistory: preparedCall?.systemPromptUpdate === 'in-history',",
      "        inHistory: !assembly.admission && preparedCall?.systemPromptUpdate === 'in-history',")
    text = text.replaceAll('const context = this.runtimeContext.project(joinContextSections(sections), sections)',
      'const context = assembly.admission ? undefined : this.runtimeContext.project(joinContextSections(sections), sections)')
    return replaceOnce(text, '        for (const message of decision.messages) {',
      "        for (const message of decision.developerMessages ?? []) {\n          this.session.append('developer/message', { turn, step, message }, { surfaceOp: 'append' })\n        }\n        for (const message of decision.messages) {");
  },
  'packages/core/system-prompt/src/index.ts': text => {
    text = replaceOnce(text, 'export interface PromptPresentation {', `export interface PromptPresentation {
  /** A run compositor may own final message admission and the accepted context snapshot. */
  admission?: { messages: import('@deepseek-ai/dsh-llm').UserMessage[]; developerMessages: import('@deepseek-ai/dsh-llm').DeveloperMessage[]; messageReplacements: { seq: import('@deepseek-ai/dsh-session').SessionSeq; message: import('@deepseek-ai/dsh-llm').DeveloperMessage | import('@deepseek-ai/dsh-llm').UserMessage }[]; tools: ToolSchema[]; sections: AssembledSection[]; contexts: AssembledContext[] }`);
    text = replaceOnce(text, '  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {',
      '  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {\n    if (assembly.admission) return assembly');
    return replaceOnce(text, '    if (completeSection === undefined && !runtimeContextSuppressed)',
      '    if (transformed.admission) return { ...transformed, tools: transformed.admission.tools, sections: transformed.admission.sections, contexts: transformed.admission.contexts }\n    if (completeSection === undefined && !runtimeContextSuppressed)');
  },
  'packages/llm/llm/src/content.ts': text => {
    text = replaceOnce(text, `  const retained = messages.filter(message => message.role !== 'developer')
  return retained.length === messages.length ? messages : retained`,
      `  const retained: RequestMessage[] = []
  for (const message of messages) {
    if (message.role !== 'developer') {
      retained.push(message)
      continue
    }
    const content = message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal')
    if (content.length > 0) retained.push(content.length === message.content.length ? message : { ...message, content })
  }
  return retained.length === messages.length && retained.every((message, index) => message === messages[index]) ? messages : retained`);
    text = replaceOnce(text, '    if (!updateIds.has(message.id)) continue',
      `    if (!updateIds.has(message.id)) {
      projectedMessages.push(...withoutDeveloperMessages([message]))
      continue
    }`);
    return text.replaceAll('withoutDeveloperMessages', 'withoutToolChangeBlocks')
      .replace('Unsupported routes and incomplete history use current declarations without developer updates.', 'Unsupported routes and incomplete history use current declarations without tool-change blocks; developer instructions remain intact.')
      .replace('// Unsupported routes need immediately available tools and no update messages.', '// Unsupported routes need immediately available tools and no tool-change blocks.');
  },
};
try {
  let patch = '';
  for (const [relative, transform] of Object.entries(edits)) {
    const original = await readFile(join(source, relative), 'utf8');
    const changed = transform(original);
    await writeFile(join(temporary, 'before'), original); await writeFile(join(temporary, 'after'), changed);
    const diff = spawnSync('diff', ['-u', '-L', `a/${relative}`, '-L', `b/${relative}`, join(temporary, 'before'), join(temporary, 'after')], { encoding: 'utf8' });
    if (diff.status !== 1) throw new Error(`Cannot produce patch: ${diff.stderr}`);
    patch += diff.stdout;
  }
  await mkdir(join(root, 'proposals'), { recursive: true });
  const output = join(root, 'proposals/dsh-developer-admission.patch');
  await writeFile(output, patch);
  const check = spawnSync('patch', ['--dry-run', '-p1', '-i', output], { cwd: source, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stdout + check.stderr);
  console.log('Generated four-file proposal; dry-run applies to the pinned source. Installation unchanged.');
} finally { await rm(temporary, { recursive: true, force: true }); }
