import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { assembleContext } from './events.ts';
import type { AssemblyWindow } from './events.ts';

export interface StepInput {
  readonly turn: number;
  readonly step: number;
  readonly messages: readonly UserMessage[];
}

function acceptMessage(value: unknown): UserMessage {
  const snapshot = snapshotJsonValue(value) as Record<string, unknown> | undefined;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.role !== 'user' || typeof snapshot.id !== 'string' || !snapshot.id
    || !Array.isArray(snapshot.content) || !snapshot.source || typeof snapshot.source !== 'object'
    || Array.isArray(snapshot.source) || typeof (snapshot.source as Record<string, unknown>).kind !== 'string') {
    throw new Error('Expected an identified native DSH UserMessage');
  }
  // DSH validates native content when admitting the returned pre-step decision.
  return freezeMessage(snapshot as unknown as UserMessage);
}

/** The existing DSH pre-step boundary accepts UserMessages, not arbitrary roles or histories. */
export const stepInputWindow: AssemblyWindow<StepInput, UserMessage> = Object.freeze({
  name: 'dsh.agent/pre-step',
  input: (input: StepInput) => Object.freeze({ turn: input.turn, step: input.step,
    messages: Object.freeze(input.messages.map(acceptMessage)) }),
  accept: acceptMessage,
});

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:context-connectors/assembly': {
      eventId: string; event: string; phase: 'prepared'; turn: number; step: number;
      contributions: { owner: string; key: string; messageId: string }[];
    };
  }
}

/** One native boundary adapter. It has no prompt, skill, workspace or turn-count branches. */
export function installInputAssembly(ctx: Context, agent: Agent): void {
  ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next();
    // DSH scoped listeners also receive descendant events. This bridge owns exactly one Agent.
    if (input.agent !== agent) return decision;
    if (decision.kind === 'reject') return decision;
    const assembly = await assembleContext(ctx, agent, stepInputWindow,
      { turn: input.turn, step: input.step, messages: decision.messages }, input.signal);
    const ids = new Set<string>();
    for (const item of assembly.contributions) {
      if (ids.has(item.value.id)) throw new Error(`Conflicting native message identity at ${item.owner}/${item.key}`);
      ids.add(item.value.id);
    }
    appendPluginRecord(agent.session, 'plugin:context-connectors/assembly', {
      eventId: assembly.eventId, event: stepInputWindow.name, phase: 'prepared', turn: input.turn, step: input.step,
      contributions: assembly.contributions.map(item => ({ owner: item.owner, key: item.key, messageId: item.value.id })),
    });
    return { ...decision, messages: assembly.contributions.map(item => item.value) };
  });
}
