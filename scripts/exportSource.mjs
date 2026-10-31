/** Produce a standalone source tree from an explicit allowlist; never copy host state. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'context-os-source-'));
const destination = join(temporary, pkg.name);
const entries = ['src', 'scripts', 'tests', 'examples', 'proposals', 'package.json',
  'README.md', 'README.zh-CN.md', 'docs', 'LICENSE', 'NOTICE', 'cordis.patch.yml', '.gitignore'];
async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Source export cannot include symbolic links: ${entry.name}`);
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.test-artifacts'
      || entry.name === '.DS_Store' || entry.name.startsWith('._') || entry.name.startsWith('.env')) {
      throw new Error(`Source export contains local state: ${entry.name}`);
    }
    if (entry.isDirectory()) await checkTree(join(directory, entry.name));
  }
}
try {
  await mkdir(destination);
  for (const entry of entries) await cp(join(root, entry), join(destination, entry), { recursive: true, errorOnExist: true });
  await checkTree(destination);
  const output = resolve(process.argv[2] || join(root, '.test-artifacts', `${pkg.name}-${pkg.version}-source.tar.gz`));
  await mkdir(dirname(output), { recursive: true });
  execFileSync('tar', ['-czf', output, '-C', temporary, pkg.name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  console.log(`Exported standalone source: ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
