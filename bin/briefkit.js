#!/usr/bin/env -S node --import tsx/esm
import { runCli } from '../src/lib/cli.ts';

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
