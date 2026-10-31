import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { EventConnector } from './events.ts';
import type { StepInput } from './dshInput.ts';

/** All native inbox deliveries share this path: initial input, follow-up and injected context. */
export const inputConnector: EventConnector<StepInput, UserMessage> = {
  id: 'native-input',
  async handle(event) {
    return event.input.messages.map(message => ({ key: message.id, value: message }));
  },
};
