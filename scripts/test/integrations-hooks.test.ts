import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EVENTS = ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']

interface Hook {
  type: string
  command: string
  timeout: number
}
interface Entry {
  matcher?: string
  hooks: Hook[]
}

const file = join(import.meta.dir, '../../integrations/claude-code/hooks.json')
const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Entry[]> }).hooks

test('hooks.json covers exactly the six factory events', () => {
  expect(Object.keys(hooks).sort()).toEqual(EVENTS)
})

test('every command is a factory hook guarded by FACTORY_SESSION', () => {
  for (const [event, entries] of Object.entries(hooks)) {
    expect(entries.length).toBe(1)
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        expect(hook.type).toBe('command')
        expect(hook.command.startsWith('[ -n "$FACTORY_SESSION" ]')).toBe(true)
        expect(hook.command).toContain('factory hook ')
        expect(hook.timeout, event).toBeGreaterThan(0)
      }
    }
  }
})
