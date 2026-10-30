#!/usr/bin/env bun
export {}

// `factory hook` runs inside every hook of a session, so it gets the lean path: nothing but the hook module is loaded.
if (process.argv[2] === 'hook') {
  const { hookMain } = await import('../src/hook.ts')
  process.exitCode = await hookMain(process.argv.slice(3), process.env)
} else {
  const { run } = await import('../src/run.ts')
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  })
}
