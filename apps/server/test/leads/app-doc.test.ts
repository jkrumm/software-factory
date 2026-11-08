import { describe, expect, test } from 'bun:test'
import { APP_DOC, nameTab, type Rpc } from '../../src/adapters/hc/app-doc.ts'
import { HcError } from '../../src/adapters/hc/client.ts'
import { tabName } from '../../src/domains/leads/names.ts'

/** An in-memory core: one document with a version, `conflict` on a stale `doc.set`. */
function fakeCore(value: unknown) {
  const state = { value, version: 1, sets: 0, beforeSet: null as (() => void) | null }
  const rpc = (async (method: string, params: Record<string, unknown>) => {
    if (params.name !== APP_DOC) throw new Error(`unexpected doc ${String(params.name)}`)
    if (method === 'doc.get') return { value: structuredClone(state.value), version: state.version }
    state.beforeSet?.()
    state.beforeSet = null
    if (params.version !== state.version) throw new HcError('stale', { kind: 'conflict' })
    state.sets++
    state.value = params.value
    return { version: ++state.version }
  }) as Rpc
  return { state, rpc }
}

const doc = (tabs: object[], extra: object = {}) => ({
  theme: 'dark',
  spaces: [
    { id: 'sp-1', name: 'repo', tabs },
    { id: 'sp-2', name: 'other', tabs: [{ id: 'tb-9' }], ...extra },
  ],
})

describe('nameTab in the app document', () => {
  test('an absent entry is not settled and leaves the document alone; once adopted it is named', async () => {
    const core = fakeCore(doc([]))
    expect(await nameTab(core.rpc, 'tb-1', 'Lead: x')).toBe(false)
    expect(core.state.sets).toBe(0)

    ;(core.state.value as ReturnType<typeof doc>).spaces[0]?.tabs.push({ id: 'tb-1' })
    expect(await nameTab(core.rpc, 'tb-1', 'Lead: x')).toBe(true)
    expect(core.state.value).toEqual(doc([{ id: 'tb-1', name: 'Lead: x' }]))
  })

  test('a conflict reads again and lands, keeping what the other writer wrote', async () => {
    const core = fakeCore(doc([{ id: 'tb-1' }]))
    core.state.beforeSet = () => {
      const value = core.state.value as Record<string, unknown>
      value.theme = 'light'
      core.state.version++
    }
    expect(await nameTab(core.rpc, 'tb-1', 'Lead: x')).toBe(true)
    expect(core.state.value).toEqual({ ...doc([{ id: 'tb-1', name: 'Lead: x' }]), theme: 'light' })
  })

  test('a tab with a name is never overwritten', async () => {
    const core = fakeCore(doc([{ id: 'tb-1', name: 'mine' }]))
    expect(await nameTab(core.rpc, 'tb-1', 'Lead: x')).toBe(true)
    expect(core.state.sets).toBe(0)
  })

  test("another tab's entry is untouched", async () => {
    const core = fakeCore(doc([{ id: 'tb-1' }, { id: 'tb-2', name: 'keep' }]))
    await nameTab(core.rpc, 'tb-1', 'Lead: x')
    expect(core.state.value).toEqual(
      doc([
        { id: 'tb-1', name: 'Lead: x' },
        { id: 'tb-2', name: 'keep' },
      ]),
    )
  })
})

describe('tabName', () => {
  test('the topic is the start of the title', () => {
    expect(tabName("A lead's Herdr tab carries its Issue's title, not a number")).toBe("Lead: lead's Herdr tab carries")
  })
  test('an article is dropped, a colon does not cut', () => {
    expect(tabName('The server: fix it')).toBe('Lead: server: fix it')
    expect(tabName('an Issue — long')).toBe('Lead: Issue')
  })
  test('never longer than 32 characters', () => {
    for (const title of [
      'Implement the extraordinarily verbose naming scheme',
      'one two three four five six',
      'x'.repeat(80),
    ]) {
      expect(tabName(title).length).toBeLessThanOrEqual(32)
    }
    expect(tabName('Implement extraordinarily verbose')).toBe('Lead: Implement extraordinarily')
  })
  test('a blank title is Lead; one long word is cut to fit', () => {
    expect(tabName('   ')).toBe('Lead')
    expect(tabName('')).toBe('Lead')
    expect(tabName('x'.repeat(80))).toBe(`Lead: ${'x'.repeat(26)}`)
  })
})
