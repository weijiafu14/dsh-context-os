/** Resolve either a prebuilt DSH monorepo checkout or an installed DSH runtime directory. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DSH_COMMIT = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';

export function detectDshLayout(candidate) {
  if (!candidate) return undefined;
  const root = resolve(candidate);
  if (existsSync(join(root, 'packages/core/agent-loop/lib/index.js'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/core/agent-loop/package.json'), 'utf8'));
    return {
      root,
      kind: 'monorepo',
      version: pkg.version,
      targets: {
        '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop/lib/index.js',
        '@deepseek-ai/dsh-llm': 'packages/llm/llm/lib/index.js',
        '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt/lib/index.js',
      },
      cliBin: 'apps/cli/lib/bin.js',
    };
  }
  if (existsSync(join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'))) {
    const pkg = JSON.parse(
      readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/package.json'), 'utf8'),
    );
    return {
      root,
      kind: 'installed',
      version: pkg.version,
      targets: {
        '@deepseek-ai/dsh-agent-loop': 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
        '@deepseek-ai/dsh-llm': 'node_modules/@deepseek-ai/dsh-llm/lib/index.js',
        '@deepseek-ai/dsh-system-prompt': 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js',
      },
      cliBin: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    };
  }
  return undefined;
}

export function dshLayout(explicitRoot) {
  const candidates = [
    explicitRoot,
    process.env.DSH_SOURCE_ROOT,
    process.env.DSH_CONTEXT_NATIVE_ROOT,
  ];
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop');
    const monoSuffix = '/packages/core/agent-loop/lib/index.js';
    const instSuffix = '/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
    if (entry.endsWith(monoSuffix)) candidates.push(entry.slice(0, -monoSuffix.length));
    if (entry.endsWith(instSuffix)) candidates.push(entry.slice(0, -instSuffix.length));
  } catch {
    /* Peer links may not be installed yet. */
  }
  candidates.push(
    join(homedir(), '.local/share/dsh-carbon-test/runtime'),
    join(homedir(), '.cache/dsh-context-os', DSH_COMMIT),
  );
  for (const candidate of candidates) {
    const detected = detectDshLayout(candidate);
    if (detected) return detected;
  }
  throw new Error(
    'Compatible DeepSeek Harness runtime not found. Set DSH_SOURCE_ROOT to a prebuilt DSH monorepo or installed DSH runtime directory.',
  );
}

export function dshSource() {
  return dshLayout().root;
}

export function createBuildRequire(projectRoot, sourceRoot) {
  const localPkg = join(projectRoot, 'package.json');
  const localReq = createRequire(localPkg);
  try {
    localReq.resolve('esbuild');
    localReq.resolve('typescript');
    return localReq;
  } catch {
    const pnpmPkg = join(sourceRoot, 'node_modules/.pnpm/node_modules/package.json');
    if (existsSync(pnpmPkg)) return createRequire(pnpmPkg);
    return localReq;
  }
}

export function resolvePackageRoot(pkgJsonPath) {
  return dirname(pkgJsonPath);
}
