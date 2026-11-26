#!/usr/bin/env node
/** Launch a compatible DSH monorepo or installed runtime with this package's preparation bridge. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let nativeRoot = process.env.DSH_CONTEXT_NATIVE_ROOT;
if (args[0] === '--dsh-root') {
  args.shift();
  nativeRoot = args.shift();
}
if (!nativeRoot) {
  const defaultRuntime = join(homedir(), '.local/share/dsh-carbon-test/runtime');
  if (existsSync(join(defaultRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
    nativeRoot = defaultRuntime;
  }
}
if (!nativeRoot || args[0] === '--launcher-help') {
  console.error(
    'Usage: dsh-context-os [--dsh-root /path/to/compatible/dsh] [DSH arguments]\nAlternatively set DSH_CONTEXT_NATIVE_ROOT. Use --profile web to launch DSH Web.',
  );
  process.exitCode = nativeRoot ? 0 : 1;
} else {
  const resolvedRoot = resolve(nativeRoot);
  process.env.DSH_CONTEXT_NATIVE_ROOT = resolvedRoot;
  const binCandidates = [
    resolve(resolvedRoot, 'apps/cli/lib/bin.js'),
    resolve(resolvedRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ];
  const bin = binCandidates.find((p) => existsSync(p));
  if (!bin) {
    throw new Error(`DSH CLI entry not found under ${resolvedRoot}`);
  }
  // The host observes its normal argv and canonical module identities.
  process.argv = [process.execPath, bin, ...args];
  await import('./register.mjs');
  const mod = await import(pathToFileURL(bin).href);
  if (typeof mod.runCli === 'function') {
    await mod.runCli();
  }
}
