import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SkillRegistration } from '@deepseek-ai/dsh-skill';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { parseSelection, validateSelection } from '../core.ts';
import type { ConnectorBinding, ConnectorCard, RunSelection } from '../core.ts';
import type { ContextConnector } from '../composition.ts';

export interface DiscoveryContext { cwd: string; signal?: AbortSignal; }
/** Source-specific conversion belongs in prepare(), never in the registry. */
export interface ConnectorContribution {
  instructions?: string;
  messages?: UserMessage[];
  skills?: SkillRegistration[];
  skillNames?: string[];
  toolNames?: string[];
  tools?: ToolDefinition[];
  seed?: SessionEvent[];
  parentSessionId?: string;
  dispose?: () => void | Promise<void>;
}
export interface ConnectorProvider {
  id: string;
  list(context: DiscoveryContext): Promise<ConnectorCard[]>;
  prepare?(binding: ConnectorBinding, context: DiscoveryContext): Promise<ConnectorContribution>;
  connect?(binding: ConnectorBinding, context: DiscoveryContext): Promise<ContextConnector>;
}
export interface PreparedComposition {
  selection: RunSelection;
  cards: ConnectorCard[];
  contributions: ConnectorContribution[];
  contributionOwners: string[];
  connectors: ContextConnector[];
  dispose(): Promise<void>;
}
const releases = new WeakMap<ConnectorContribution, () => Promise<void>>();
/** Shared lifetime guard for a provider-owned resource; never mutate its descriptor. */
export async function releaseContribution(source: ConnectorContribution): Promise<void> {
  let release = releases.get(source);
  if (!release) {
    let released: Promise<void> | undefined;
    release = () => released ??= Promise.resolve().then(() => source.dispose?.());
    releases.set(source, release);
  }
  await release();
}

/** Trusted same-process provider registry. This API is not a sandbox for arbitrary Node packages. */
export class ConnectorRegistry {
  private providers = new Map<string, ConnectorProvider>();

  registerProvider(provider: ConnectorProvider): () => void {
    if (!provider.id || this.providers.has(provider.id)) throw new Error(`Duplicate connector provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); };
  }

  private async discover(context: DiscoveryContext) {
    const owners = new Map<string, ConnectorProvider>();
    const cards: ConnectorCard[] = [];
    for (const provider of this.providers.values()) {
      context.signal?.throwIfAborted();
      for (const card of await provider.list(context)) {
        if (owners.has(card.id)) throw new Error(`Duplicate connector identity: ${card.id}`);
        owners.set(card.id, provider);
        // Only the public descriptor crosses the browser boundary.
        cards.push({ id: card.id, kind: card.kind, label: card.label, description: card.description,
          ...(card.fields ? { fields: card.fields } : {}), ...(card.disabledReason ? { disabledReason: card.disabledReason } : {}) });
      }
    }
    return { cards, owners };
  }

  async catalog(context: DiscoveryContext): Promise<ConnectorCard[]> { return (await this.discover(context)).cards; }

  async prepare(input: unknown, context: DiscoveryContext): Promise<PreparedComposition> {
    const selection = parseSelection(input);
    const { cards, owners } = await this.discover(context);
    validateSelection(selection, cards);
    const contributions: ConnectorContribution[] = [];
    const contributionOwners: string[] = [];
    const connectors: ContextConnector[] = [];
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const item of [...contributions].reverse()) {
        try { await releaseContribution(item); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Connector cleanup failed');
    };
    try {
      for (const binding of selection.bindings) {
        context.signal?.throwIfAborted();
        const provider = owners.get(binding.id)!;
        if (this.providers.get(provider.id) !== provider) throw new Error('Connector provider changed during preparation');
        if (provider.connect) {
          const connector = await provider.connect(binding, context);
          if (connector.id !== binding.id) throw new Error('Connected instance must retain its selected identity');
          connectors.push(connector);
        } else if (provider.prepare) {
          const source = await provider.prepare(binding, context);
          contributions.push(source);
          contributionOwners.push(binding.id);
        }
        else throw new Error('Provider has no connector factory');
      }
      if (contributions.filter(item => item.seed !== undefined).length > 1) throw new Error('Multiple native session histories cannot be concatenated');
      return { selection, cards: selection.bindings.map(binding => cards.find(card => card.id === binding.id)!), contributions, contributionOwners, connectors, dispose };
    } catch (error) {
      await dispose().catch(() => {});
      throw error;
    }
  }
}

