#!/usr/bin/env bun
import { main } from '../src/cli.ts'

try {
  process.exit(await main(process.argv.slice(2)))
} catch (e) {
  console.error(`claude-account: ${(e as Error).message}`)
  process.exit(2)
}
