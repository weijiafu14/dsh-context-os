/** Resolve a public, prebuilt DSH checkout without depending on the integrating host. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DSH_COMMIT = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
export function dshSource() {
  let root = process.env.DSH_SOURCE_ROOT;
  if (!root) {
    try {
      const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop');
      const suffix = '/packages/core/agent-loop/lib/index.js';
      if (entry.endsWith(suffix)) root = entry.slice(0, -suffix.length);
    } catch { /* A fresh source export has no installed peer links yet. */ }
  }
  root = resolve(root || join(homedir(), '.cache/dsh-context-os', DSH_COMMIT));
  if (!existsSync(join(root, 'packages/core/agent-loop/lib/index.js'))) {
    throw new Error(`Build DeepSeek Harness at ${DSH_COMMIT}, then set DSH_SOURCE_ROOT to that checkout.`);
  }
  return root;
}
