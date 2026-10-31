import { dshSource } from './dshSource.mjs';
/** Build an opt-in process bootstrap; preserve canonical DSH module identities. */
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { candidateLoop } from '../tests/fixtures/developerLoop.mjs';

const source = dshSource();
const output = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '../dist/runtime'));
const candidate = await candidateLoop();
try {
  await mkdir(output, { recursive: true });
  await copyFile(new URL('./runtimeCli.mjs', import.meta.url), join(output, 'cli.mjs'));
  await chmod(join(output, 'cli.mjs'), 0o755);
  const entries = [];
  for (const [file, target] of [['loop.mjs', 'packages/core/agent-loop/lib/index.js'], ['llm.mjs', 'packages/llm/llm/lib/index.js'], ['prompt.mjs', 'packages/core/system-prompt/lib/index.js']]) {
    const code = (await readFile(join(candidate.root, 'lib', file), 'utf8')).replaceAll(JSON.stringify(source).slice(1, -1), '__DSH_CONTEXT_NATIVE_ROOT__');
    await writeFile(join(output, file), code);
    entries.push({ file, target, sha256: createHash('sha256').update(await readFile(join(source, target))).digest('hex') });
  }
  await copyFile(join(source, 'LICENSE'), join(output, 'LICENSE.dsh'));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ commit: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60', entries }, null, 2));
  await writeFile(join(output, 'register.mjs'), `import { registerHooks, createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
let root = process.env.DSH_CONTEXT_NATIVE_ROOT;
if (!root && process.argv[1]?.endsWith('/apps/cli/lib/bin.js')) root = process.argv[1].slice(0, -'/apps/cli/lib/bin.js'.length);
if (!root) {
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop');
    const suffix = '/packages/core/agent-loop/lib/index.js';
    if (entry.endsWith(suffix)) root = entry.slice(0, -suffix.length);
  } catch {}
}
if (!root) throw new Error('Set DSH_CONTEXT_NATIVE_ROOT to the compatible DSH artifact');
const replacements = new Map();
for (const entry of manifest.entries) {
  const target = realpathSync(join(root, entry.target));
  const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (hash !== entry.sha256) throw new Error('Context runtime does not match the pinned DSH build: ' + entry.target);
  const code = readFileSync(join(directory, entry.file), 'utf8').replaceAll('__DSH_CONTEXT_NATIVE_ROOT__', JSON.stringify(root).slice(1, -1));
  replacements.set(pathToFileURL(target).href, code);
}
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  return replacements.has(url) ? { ...loaded, source: replacements.get(url) } : loaded;
} });
globalThis[Symbol.for('dsh.context-composition.runtime')] = Object.freeze({ version: 3, commit: manifest.commit });
`);
  console.log(`Built isolated native bootstrap: ${output}`);
} finally { await candidate.dispose(); }
