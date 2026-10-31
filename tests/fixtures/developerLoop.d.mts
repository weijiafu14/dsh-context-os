import type AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type LlmRuntime from '@deepseek-ai/dsh-llm';
import type { projectToolUpdates } from '@deepseek-ai/dsh-llm';

export function candidateLoop(): Promise<{
  loop: typeof AgentLoop;
  llm: typeof LlmRuntime;
  projectToolUpdates: typeof projectToolUpdates;
  root: string;
  dispose(): Promise<void>;
}>;
