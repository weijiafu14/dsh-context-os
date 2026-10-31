#!/usr/bin/env node
/** Launch the pinned DSH host with this installed package's preparation bridge. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let nativeRoot = process.env.DSH_CONTEXT_NATIVE_ROOT;
if (args[0] === '--dsh-root') {
  args.shift();
  nativeRoot = args.shift();
}
if (!nativeRoot || args[0] === '--launcher-help') {
  console.error('Usage: dsh-context-os --dsh-root /path/to/compatible/dsh [DSH arguments]\nAlternatively set DSH_CONTEXT_NATIVE_ROOT. Use --profile web to launch DSH Web.');
  process.exitCode = nativeRoot ? 0 : 1;
} else {
  process.env.DSH_CONTEXT_NATIVE_ROOT = resolve(nativeRoot);
  const bin = resolve(nativeRoot, 'apps/cli/lib/bin.js');
  // The host observes its normal argv and canonical module identities.
  process.argv = [process.execPath, bin, ...args];
  await import('./register.mjs');
  const { runCli } = await import(pathToFileURL(bin).href);
  await runCli();
}
