import { dshLayout } from './dshSource.mjs';
/** Build an opt-in process bootstrap; preserve canonical DSH module identities across monorepo and installed runtimes. */
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { candidateLoop } from '../tests/fixtures/developerLoop.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = dshLayout();
const source = layout.root;
const output = resolve(process.argv[2] || join(projectRoot, 'dist/runtime'));
const candidate = await candidateLoop();
try {
  await mkdir(output, { recursive: true });
  await copyFile(new URL('./runtimeCli.mjs', import.meta.url), join(output, 'cli.mjs'));
  await chmod(join(output, 'cli.mjs'), 0o755);

  const specs = [
    ['loop.mjs', '@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop/lib/index.js', 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'],
    ['llm.mjs', '@deepseek-ai/dsh-llm', 'packages/llm/llm/lib/index.js', 'node_modules/@deepseek-ai/dsh-llm/lib/index.js'],
    ['prompt.mjs', '@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt/lib/index.js', 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'],
  ];

  const entries = [];
  for (const [file, pkgName, monoTarget, installedTarget] of specs) {
    const activeRelTarget = layout.targets[pkgName];
    const code = (await readFile(join(candidate.root, 'lib', file), 'utf8')).replaceAll(
      JSON.stringify(source).slice(1, -1),
      '__DSH_CONTEXT_NATIVE_ROOT__',
    );
    await writeFile(join(output, file), code);
    entries.push({
      file,
      pkgName,
      target: activeRelTarget,
      candidates: [monoTarget, installedTarget],
      sha256: createHash('sha256').update(await readFile(join(source, activeRelTarget))).digest('hex'),
    });
  }

  const licenseCandidates = [
    join(source, 'LICENSE'),
    join(source, 'node_modules/@deepseek-ai/dsh/LICENSE'),
    join(projectRoot, 'LICENSE'),
  ];
  const licenseFile = licenseCandidates.find((p) => existsSync(p));
  if (licenseFile) await copyFile(licenseFile, join(output, 'LICENSE.dsh'));

  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify({ version: layout.version, kind: layout.kind, entries }, null, 2),
  );

  await writeFile(
    join(output, 'register.mjs'),
    `import { registerHooks, createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
let root = process.env.DSH_CONTEXT_NATIVE_ROOT;
if (!root && process.argv[1]?.endsWith('/apps/cli/lib/bin.js')) root = process.argv[1].slice(0, -'/apps/cli/lib/bin.js'.length);
if (!root && process.argv[1]?.endsWith('/node_modules/@deepseek-ai/dsh/lib/bin.js')) root = process.argv[1].slice(0, -'/node_modules/@deepseek-ai/dsh/lib/bin.js'.length);
if (!root) {
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop');
    for (const suffix of ['/packages/core/agent-loop/lib/index.js', '/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js']) {
      if (entry.endsWith(suffix)) { root = entry.slice(0, -suffix.length); break; }
    }
  } catch {}
}
if (!root) throw new Error('Set DSH_CONTEXT_NATIVE_ROOT to the compatible DSH artifact');
const replacements = new Map();
for (const entry of manifest.entries) {
  const rel = (entry.candidates ?? [entry.target]).find(c => existsSync(join(root, c))) ?? entry.target;
  const target = realpathSync(join(root, rel));
  const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (hash !== entry.sha256) throw new Error('Context runtime does not match the pinned DSH build: ' + rel);
  const code = readFileSync(join(directory, entry.file), 'utf8').replaceAll('__DSH_CONTEXT_NATIVE_ROOT__', JSON.stringify(root).slice(1, -1));
  replacements.set(pathToFileURL(target).href, code);
}
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  return replacements.has(url) ? { ...loaded, source: replacements.get(url) } : loaded;
} });
globalThis[Symbol.for('dsh.context-composition.runtime')] = Object.freeze({ version: 3, dshVersion: manifest.version });
`,
  );
  console.log(`Built isolated native bootstrap (${layout.kind} DSH ${layout.version}): ${output}`);
} finally {
  await candidate.dispose();
}
