import { dshSource } from './dshSource.mjs';
/** Check consumer examples and event contracts against the same DSH types as the build. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = dshSource();
const require = createRequire(join(source, 'node_modules/.pnpm/node_modules/package.json'));
const { compilerOptions } = JSON.parse(await readFile(join(root, 'node_modules/tsconfig.host.json'), 'utf8'));
Object.assign(compilerOptions, { noEmit: true, declaration: false, emitDeclarationOnly: false, rootDir: root });
const files = (await readdir(join(root, 'tests'))).filter(file => file.endsWith('.ts')).map(file => join(root, 'tests', file));
files.push(join(root, 'examples/documentService.ts'));
const config = join(root, 'node_modules/tsconfig.contracts.json');
await writeFile(config, JSON.stringify({ compilerOptions, files }));
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
