import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEPLOY = join(import.meta.dir, '..', 'deploy.sh')

let home = ''

beforeAll(async () => {
  home = await mkdtemp('/tmp/factory-deploy-hook-')
  await mkdir(join(home, 'Library', 'Logs'), { recursive: true })
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Sources deploy.sh (it runs nothing when sourced) and calls the post-deploy hook step. */
async function runHook(hook: string | null): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', '-c', `source "${DEPLOY}"; post_deploy_hook /rel/dir abc123`], {
    env: { ...process.env, HOME: home, FACTORY_POST_DEPLOY_HOOK: hook ?? join(home, 'no-such-hook') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}${err}` }
}

async function until(path: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text !== '') return text
    await Bun.sleep(100)
  }
  throw new Error(`${path} was never written`)
}

test('a missing hook is nothing: no output, exit 0', async () => {
  const ran = await runHook(null)
  expect(ran).toEqual({ code: 0, out: '' })
})

test('a hook that is not executable is not run', async () => {
  const hook = join(home, 'plain-file')
  await writeFile(hook, '#!/bin/sh\ntouch "$HOME/plain-ran"\n')
  expect((await runHook(hook)).out).toBe('')
  expect(await Bun.file(join(home, 'plain-ran')).exists()).toBe(false)
})

test('the hook gets the release dir and the sha, runs in the background and logs to the host log', async () => {
  const hook = join(home, 'hook.sh')
  await writeFile(hook, '#!/bin/sh\necho "args=$1 $2"\nprintf "%s %s" "$1" "$2" > "$HOME/hook-args"\n')
  await chmod(hook, 0o755)
  const ran = await runHook(hook)
  expect(ran.code).toBe(0)
  expect(ran.out).toContain('post-deploy hook started')
  expect(await until(join(home, 'hook-args'))).toBe('/rel/dir abc123')
  expect(await until(join(home, 'Library', 'Logs', 'factory-post-deploy.log'))).toContain('args=/rel/dir abc123')
})

test('a failing hook never fails the deploy step', async () => {
  const hook = join(home, 'fails.sh')
  await writeFile(hook, '#!/bin/sh\nexit 7\n')
  await chmod(hook, 0o755)
  expect((await runHook(hook)).code).toBe(0)
})
