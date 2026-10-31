import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';

export const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
export type Response = { text: string } | { fail: string } | { callId: string; name: string; args: Record<string, unknown> };

export class RecordedModel extends LlmAdapter {
  requests: GenerateOptions[] = [];
  readonly script: Response[] | ((request: GenerateOptions) => Response);
  constructor(script: Response[] | ((request: GenerateOptions) => Response)) { super(); this.script = script; }
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const response = typeof this.script === 'function' ? this.script(request) : this.script.shift();
    if (!response) throw new Error('Model fixture exhausted');
    if ('fail' in response) throw new Error(response.fail);
    if ('text' in response) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: response.text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response.text } };
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { opaqueFixture: response.text } } };
    } else {
      const id = ToolCallId(response.callId); const args = JSON.stringify(response.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: response.name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
}

export async function nativeHarness(loop: typeof import('@deepseek-ai/dsh-agent-loop').default, script: Response[] | ((request: GenerateOptions) => Response), llm: typeof LlmRuntime = LlmRuntime) {
  const ctx = new Context(); const model = new RecordedModel(script);
  if (process.env.CONTEXT_FRAME_DEBUG) ctx.on('agent/error', ({ error }) => { process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n'); });
  for (const plugin of [llm, SessionStore, SessionProjections, SystemPrompt, Tools, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(loop, { agents: [] });
  ctx.llm.registerAdapter(['fixture'], model);
  return { ctx, model };
}
