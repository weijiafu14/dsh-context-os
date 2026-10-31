import { dshSource } from './dshSource.mjs';
/** Run the existing upstream content regression against the isolated candidate. */
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { candidateLoop } from '../tests/fixtures/developerLoop.mjs';

const source = dshSource();
const require = createRequire(join(source, 'node_modules/.pnpm/node_modules/package.json'));
const original = join(source, 'packages/llm/llm/tests/content.spec.ts');
const localRequire = createRequire(original);
const candidate = await candidateLoop();
try {
  const vitest = dirname(require.resolve('vitest/package.json'));
  await mkdir(join(candidate.root, 'node_modules'));
  await symlink(vitest, join(candidate.root, 'node_modules/vitest'));
  const test = (await readFile(original, 'utf8'))
    .replaceAll("'../src/index.ts'", "'./lib/llm.mjs'")
    .replaceAll("'@deepseek-ai/dsh-attachment'", JSON.stringify(localRequire.resolve('@deepseek-ai/dsh-attachment')));
  await writeFile(join(candidate.root, 'content.spec.ts'), test);
  const config = join(candidate.root, 'vitest.config.mjs');
  await writeFile(config, `export default ${JSON.stringify({ root: candidate.root, test: { include: ['content.spec.ts'], watch: false } })};`);
  const child = spawn(process.execPath, [join(vitest, 'vitest.mjs'), 'run', '--config', config], { cwd: candidate.root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) process.exitCode = code ?? 1;
} finally { await candidate.dispose(); }
