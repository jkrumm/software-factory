import { describe, expect, test } from 'bun:test'
import type { Signal } from '@software-factory/contract'
import type { OpenIssue, Received, RepoSignals } from '../../src/domains/intake/model.ts'
import {
  fingerprintOf,
  gate,
  groupOf,
  hears,
  issueKindOf,
  matchOpen,
  originOf,
  overlap,
} from '../../src/domains/intake/rules.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const signal = (over: Partial<Signal> = {}): Signal => ({
  source: 'kuma',
  kind: 'alert',
  origin: 'infrastructure',
  trust: 'machine',
  repo: 'vps',
  fingerprint: 'f',
  title: 'vps is down',
  text: '',
  link: null,
  madeBy: null,
  ...over,
})

const project = (over: Partial<RepoSignals> = {}): RepoSignals => ({
  repo: 'vps',
  work: false,
  sources: [],
  github: null,
  launchd: [],
  heal: [],
  ...over,
})

describe('gate: who may put work in which repo', () => {
  test('a work repo hears the owner only', () => {
    const work = project({ repo: 'chat', work: true })
    expect(gate(signal({ repo: 'chat' }), work)).toMatchObject({ pass: false, detail: 'work_repo' })
    expect(gate(signal({ repo: 'chat', trust: 'agent', source: 'agent:chat' }), work)).toMatchObject({
      pass: false,
      detail: 'work_repo',
    })
    expect(gate(signal({ repo: 'chat', trust: 'owner', source: 'owner' }), work)).toEqual({ pass: true })
  })

  test('an unknown repo and a missing repo hear no one', () => {
    expect(gate(signal(), null)).toMatchObject({ pass: false, detail: 'no_project' })
    expect(gate(signal({ repo: null }), null)).toMatchObject({ pass: false, detail: 'no_repo' })
  })

  test('a project hears the sources its signals list; the door and Beszel come by route', () => {
    const listed = project({ sources: ['github'] })
    expect(gate(signal({ source: 'github' }), listed)).toEqual({ pass: true })
    expect(gate(signal({ source: 'launchd' }), listed)).toMatchObject({ pass: false, detail: 'not_listened' })
    expect(hears(project(), 'kuma')).toBe(true)
    expect(hears(project(), 'beszel')).toBe(true)
    expect(hears(project(), 'checks')).toBe(false)
  })

  test('the owner and agents are never gated by signals', () => {
    expect(gate(signal({ trust: 'owner', source: 'owner', kind: 'request' }), project())).toEqual({ pass: true })
    expect(gate(signal({ trust: 'agent', source: 'agent:vps', kind: 'request' }), project())).toEqual({ pass: true })
  })
})

describe("matching a person's signal against open Issues", () => {
  const open = (id: number, title: string): OpenIssue => ({
    id: `issue_${id}` as IssueId,
    title,
    kind: 'bug',
    state: 'queued',
  })

  test('overlap counts the words two titles share', () => {
    expect(overlap('the login page crashes on submit', 'login page crashes on submit')).toBeGreaterThan(0.8)
    expect(overlap('fix the login page', 'rotate the backup keys')).toBe(0)
  })

  test('one clear match, nothing near, or unsure', () => {
    const issues = [open(1, 'login page crashes on submit'), open(2, 'rotate the backup keys')]
    expect(matchOpen('login page crashes on submit again', issues)).toMatchObject({
      kind: 'match',
      issue: { id: 'issue_1' },
    })
    expect(matchOpen('add dark mode to settings', issues)).toEqual({ kind: 'none' })
    expect(matchOpen('login crashes', issues)).toMatchObject({ kind: 'unsure' })
  })

  test('two Issues that match equally well are unsure, never a coin flip', () => {
    const issues = [open(1, 'login page crashes on submit'), open(2, 'login page crashes on submit')]
    expect(matchOpen('login page crashes on submit', issues).kind).toBe('unsure')
  })
})

describe('correlation, origin and kind', () => {
  const topology = { hostOfRepo: new Map([['vps', 'vps']]), hosts: new Set(['vps', 'homelab']) }
  const received = (over: Partial<Signal>, subject = 'm'): Received => ({
    signal: signal(over),
    alert: { subject, event: 'e', status: 'down', facts: {} },
  })

  test("Beszel names its host in the subject, Kuma and HyperDX sit on their repo's host", () => {
    expect(groupOf(topology, received({ source: 'beszel' }, 'vps:memory'), 'vps')).toBe('host:vps')
    expect(groupOf(topology, received({ source: 'beszel' }, 'unknown:memory'), 'vps')).toBeNull()
    expect(groupOf(topology, received({ source: 'kuma' }), 'vps')).toBe('host:vps')
    expect(groupOf(topology, received({ source: 'hyperdx' }), 'vps')).toBe('host:vps')
    expect(groupOf(topology, received({ source: 'kuma' }), 'argo')).toBeNull()
    expect(groupOf(topology, received({ source: 'checks' }), 'vps')).toBeNull()
  })

  test('origin is a word a person uses; an alert is an incident, a failing check a bug', () => {
    expect(originOf('kuma')).toBe('infrastructure')
    expect(originOf('hyperdx')).toBe('application')
    expect(originOf('checks')).toBe('github')
    expect(originOf('feedback:argo')).toBe('feedback')
    expect(originOf('owner:hermes')).toBe('you')
    expect(issueKindOf(received({ source: 'kuma' }))).toBe('incident')
    expect(issueKindOf(received({ source: 'checks' }))).toBe('bug')
    expect(issueKindOf({ signal: signal({ kind: 'request' }), alert: null })).toBe('feature')
  })

  test('a fingerprint ignores case, digits and punctuation', () => {
    expect(fingerprintOf('o/r', 'Crash on page 12!')).toBe(fingerprintOf('o/r', 'crash on page 7'))
    expect(fingerprintOf('o/r', 'crash on page')).not.toBe(fingerprintOf('o/x', 'crash on page'))
  })
})
