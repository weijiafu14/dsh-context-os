import { createBuildRequire, dshLayout } from './dshSource.mjs';
import { readFile, writeFile, readdir, mkdir, symlink, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = dshLayout();
const source = layout.root;
const require = createBuildRequire(root, source);
const { build } = require('esbuild');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(join(root, 'dist/types'), { recursive: true, force: true });
await mkdir(join(root, 'node_modules/@deepseek-ai'), { recursive: true });
const paths = {};

const packageDirs = [];
if (layout.kind === 'monorepo') {
  for (const group of ['vendor', 'packages']) {
    for (const folder of await readdir(join(source, group), { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      if (group === 'vendor') {
        packageDirs.push(join(source, group, folder.name));
      } else {
        for (const sub of await readdir(join(source, group, folder.name), { withFileTypes: true })) {
          if (sub.isDirectory()) packageDirs.push(join(source, group, folder.name, sub.name));
        }
      }
    }
  }
} else {
  const scopeRoot = join(source, 'node_modules/@deepseek-ai');
  for (const entry of await readdir(scopeRoot, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      packageDirs.push(join(scopeRoot, entry.name));
    }
  }
  const topNm = join(source, 'node_modules');
  for (const extra of ['cosmokit']) {
    if (existsSync(join(topNm, extra))) packageDirs.push(join(topNm, extra));
  }
}

for (const directory of packageDirs) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (!manifest.name?.startsWith('@deepseek-ai/')) continue;
  const link = join(root, 'node_modules', manifest.name);
  try {
    await access(link);
  } catch {
    await symlink(directory, link);
  }
  for (const [subpath, entry] of Object.entries(manifest.exports || {})) {
    const type =
      typeof entry === 'string'
        ? entry.endsWith('.d.ts')
          ? entry
          : undefined
        : typeof entry === 'object' && entry !== null
          ? entry.types || entry.node?.types || (typeof entry.default === 'string' && entry.default.replace(/\.js$/, '.d.ts'))
          : undefined;
    if (typeof type === 'string' && existsSync(resolve(directory, type))) {
      paths[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(directory, type)];
    }
  }
}

for (const dependency of ['react', '@types/react', '@types/node']) {
  const destination = join(root, 'node_modules', dependency);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await access(destination);
  } catch {
    let target;
    try {
      target = dirname(require.resolve(`${dependency}/package.json`));
    } catch {
      const pnpmDir = join(source, 'node_modules/.pnpm');
      if (!existsSync(pnpmDir)) throw new Error(`Build dependency unavailable: ${dependency}`);
      const prefix = dependency.replace('/', '+') + '@';
      const match = (await readdir(pnpmDir)).find((name) => name.startsWith(prefix));
      if (!match) throw new Error(`Build dependency unavailable: ${dependency}`);
      target = join(pnpmDir, match, 'node_modules', dependency);
    }
    await symlink(target, destination);
  }
}

const common = {
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'warning',
};
await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/core.ts')],
  outdir: join(root, 'dist'),
  platform: 'node',
  format: 'esm',
});
const framework = await build({
  ...common,
  entryPoints: [join(root, 'src/framework.ts')],
  outfile: join(root, 'dist/framework.js'),
  platform: 'node',
  format: 'esm',
  metafile: true,
});
if (
  Object.keys(framework.metafile.inputs).some(
    (file) => /\/compat\//.test(file) || file.endsWith('/src/index.ts'),
  )
) {
  throw new Error('Framework imports host compatibility implementation');
}
await build({
  ...common,
  entryPoints: [join(root, 'src/compat/index.ts')],
  outfile: join(root, 'dist/compat.js'),
  platform: 'node',
  format: 'esm',
});
await build({
  ...common,
  entryPoints: [join(root, 'src/ui/ConnectorComposer.tsx')],
  outfile: join(root, 'dist/ui.js'),
  platform: 'browser',
  format: 'esm',
  jsx: 'transform',
});
await build({
  ...common,
  entryPoints: [join(root, 'src/client.tsx')],
  outfile: join(root, 'dist/client.js'),
  platform: 'browser',
  format: 'cjs',
  jsx: 'transform',
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
});
const typeRoots = [join(root, 'node_modules/@types')];
if (existsSync(join(source, 'node_modules/@types'))) {
  typeRoots.push(join(source, 'node_modules/@types'));
}
const compilerOptions = {
  target: 'ES2024',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  skipLibCheck: true,
  esModuleInterop: true,
  jsx: 'react',
  allowImportingTsExtensions: true,
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: join(root, 'src'),
  outDir: join(root, 'dist/types'),
  typeRoots,
  types: ['node', 'react'],
  paths,
};
// DSH has separate Host and browser Context declarations; validate the two faces separately.
for (const [face, files] of Object.entries({
  host: ['index.ts', 'framework.ts', 'compat/index.ts'],
  client: ['client.tsx'],
})) {
  const config = join(root, `node_modules/tsconfig.${face}.json`);
  await writeFile(
    config,
    JSON.stringify({ compilerOptions, files: files.map((file) => join(root, 'src', file)) }, null, 2),
  );
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
    stdio: 'inherit',
  });
  if (result.status) process.exit(result.status);
}
console.log(`Built ${pkg.name}@${pkg.version} (host, DSH Web, shared UI, declarations)`);
const nativeBuild = spawnSync(process.execPath, [join(root, 'scripts/buildNativeRuntime.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, DSH_SOURCE_ROOT: source },
});
if (nativeBuild.status) process.exit(nativeBuild.status);
await writeFile(
  join(root, 'dist/ui.d.ts'),
  "export { default } from './types/ui/ConnectorComposer.js';\nexport type { ConnectorComposerProps } from './types/ui/ConnectorComposer.js';\n",
);
