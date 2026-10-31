import { dshSource } from './dshSource.mjs';
import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, mkdir, symlink, access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = dshSource();
const require = createRequire(join(source, 'node_modules/.pnpm/node_modules/package.json'));
const { build } = require('esbuild');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(join(root, 'dist/types'), { recursive: true, force: true });
await mkdir(join(root, 'node_modules/@deepseek-ai'), { recursive: true });
const paths = {};
for (const group of ['vendor', 'packages']) for (const folder of await readdir(join(source, group), { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const roots = group === 'vendor' ? [join(source, group, folder.name)] : (await readdir(join(source, group, folder.name), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(source, group, folder.name, entry.name));
  for (const directory of roots) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!manifest.name?.startsWith('@deepseek-ai/')) continue;
    const link = join(root, 'node_modules', manifest.name);
    try { await access(link); } catch { await symlink(directory, link); }
    for (const [subpath, entry] of Object.entries(manifest.exports || {})) {
      const type = typeof entry === 'object' && (entry.types || entry.node?.types);
      if (typeof type === 'string') paths[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(directory, type)];
    }
  }
}
for (const dependency of ['react', '@types/react', '@types/node']) {
  const destination = join(root, 'node_modules', dependency);
  await mkdir(dirname(destination), { recursive: true });
  try { await access(destination); } catch {
    let target;
    try { target = dirname(require.resolve(`${dependency}/package.json`)); }
    catch {
      const prefix = dependency.replace('/', '+') + '@';
      const match = (await readdir(join(source, 'node_modules/.pnpm'))).find(name => name.startsWith(prefix));
      if (!match) throw new Error(`Build dependency unavailable: ${dependency}`);
      target = join(source, 'node_modules/.pnpm', match, 'node_modules', dependency);
    }
    await symlink(target, destination);
  }
}
const common = { bundle: true, target: 'es2022', sourcemap: true, external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'], logLevel: 'warning' };
await build({ ...common, entryPoints: [join(root, 'src/index.ts'), join(root, 'src/core.ts')], outdir: join(root, 'dist'), platform: 'node', format: 'esm' });
const framework = await build({ ...common, entryPoints: [join(root, 'src/framework.ts')], outfile: join(root, 'dist/framework.js'), platform: 'node', format: 'esm', metafile: true });
if (Object.keys(framework.metafile.inputs).some(file => /\/compat\//.test(file) || file.endsWith('/src/index.ts'))) throw new Error('Framework imports host compatibility implementation');
await build({ ...common, entryPoints: [join(root, 'src/compat/index.ts')], outfile: join(root, 'dist/compat.js'), platform: 'node', format: 'esm' });
await build({ ...common, entryPoints: [join(root, 'src/ui/ConnectorComposer.tsx')], outfile: join(root, 'dist/ui.js'), platform: 'browser', format: 'esm', jsx: 'transform' });
await build({ ...common, entryPoints: [join(root, 'src/client.tsx')], outfile: join(root, 'dist/client.js'), platform: 'browser', format: 'cjs', jsx: 'transform',
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` }, footer: { js: 'return module.exports;}});' },
});
const compilerOptions = { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, esModuleInterop: true,
  jsx: 'react', allowImportingTsExtensions: true, declaration: true, emitDeclarationOnly: true, rootDir: join(root, 'src'), outDir: join(root, 'dist/types'),
  typeRoots: [join(root, 'node_modules/@types'), join(source, 'node_modules/@types')], types: ['node', 'react'], paths };
// DSH has separate Host and browser Context declarations; validate the two faces separately.
for (const [face, files] of Object.entries({ host: ['index.ts', 'framework.ts', 'compat/index.ts'], client: ['client.tsx'] })) {
  const config = join(root, `node_modules/tsconfig.${face}.json`);
  await writeFile(config, JSON.stringify({ compilerOptions, files: files.map(file => join(root, 'src', file)) }, null, 2));
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log(`Built ${pkg.name}@${pkg.version} (host, DSH Web, shared UI, declarations)`);
const nativeBuild = spawnSync(process.execPath, [join(root, 'scripts/buildNativeRuntime.mjs')], { stdio: 'inherit', env: { ...process.env, DSH_SOURCE_ROOT: source } });
if (nativeBuild.status) process.exit(nativeBuild.status);
await writeFile(join(root, 'dist/ui.d.ts'), "export { default } from './types/ui/ConnectorComposer.js';\nexport type { ConnectorComposerProps } from './types/ui/ConnectorComposer.js';\n");
