/** Portable connector selection contract; contains no host credentials or business adapters. */
/** Optional presentation grouping supplied by the host; never a runtime category. */
export type ConnectorKind = string;
export interface ConnectorField {
  key: string;
  label: string;
  multiline?: boolean;
  required?: boolean;
}
export interface ConnectorCard {
  id: string;
  label: string;
  description: string;
  kind: ConnectorKind;
  fields?: ConnectorField[];
  disabledReason?: string;
}
export interface ConnectorBinding {
  id: string;
  config?: Record<string, string>;
}
export interface RunSelection {
  version: 1;
  bindings: ConnectorBinding[];
}
export interface ComposerCatalog {
  cards: ConnectorCard[];
  description?: string;
  workspaces?: Array<{ id: string; label: string }>;
  workspaceId?: string;
}

/** Parse a browser-authored selection without admitting executable code or arbitrary object fields. */
export function parseSelection(value: unknown): RunSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connector selection');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.bindings) || input.bindings.length > 64) throw new Error('Unsupported connector selection');
  const ids = new Set<string>();
  const bindings = input.bindings.map((raw): ConnectorBinding => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid connector binding');
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 512 || ids.has(item.id)) throw new Error('Invalid or duplicate connector');
    ids.add(item.id);
    const config: Record<string, string> = Object.create(null);
    if (item.config !== undefined) {
      if (!item.config || typeof item.config !== 'object' || Array.isArray(item.config)) throw new Error('Invalid connector configuration');
      for (const [key, val] of Object.entries(item.config)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key) || typeof val !== 'string' || val.length > 65536) throw new Error('Invalid connector configuration field');
        config[key] = val;
      }
    }
    return { id: item.id, ...(Object.keys(config).length ? { config } : {}) };
  });
  if (JSON.stringify(bindings).length > 262144) throw new Error('Connector selection exceeds limit');
  return { version: 1, bindings };
}

/** Validate against authoritative, freshly discovered cards rather than browser-provided metadata. */
export function validateSelection(selection: RunSelection, cards: readonly ConnectorCard[]): void {
  const catalog = new Map(cards.map(card => [card.id, card]));
  for (const binding of selection.bindings) {
    const card = catalog.get(binding.id);
    if (!card) throw new Error(`Connector is no longer available: ${binding.id}`);
    if (card.disabledReason) throw new Error(card.disabledReason);
    const fields = new Map((card.fields ?? []).map(field => [field.key, field]));
    for (const key of Object.keys(binding.config ?? {})) if (!fields.has(key)) throw new Error(`Unknown configuration field: ${key}`);
    for (const field of fields.values()) if (field.required && !binding.config?.[field.key]?.trim()) throw new Error(`Required: ${field.label}`);
  }
}

export function moveBinding(selection: RunSelection, id: string, offset: number): RunSelection {
  const bindings = selection.bindings.map(binding => ({ ...binding, config: binding.config ? { ...binding.config } : undefined }));
  const from = bindings.findIndex(binding => binding.id === id);
  const to = from + offset;
  if (from >= 0 && to >= 0 && to < bindings.length) [bindings[from], bindings[to]] = [bindings[to]!, bindings[from]!];
  return { version: 1, bindings };
}
