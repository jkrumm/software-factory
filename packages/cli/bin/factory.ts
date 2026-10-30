#!/usr/bin/env bun
import { run } from '../src/run.ts'

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
})
