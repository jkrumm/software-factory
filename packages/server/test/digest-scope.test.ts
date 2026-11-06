import { expect, test } from 'bun:test'
import type { Fleet } from '@software-factory/contract'
import { scopeOf } from '../src/fleet/digest-model.ts'

const repo = (name: string, visible: boolean): Fleet['repos'][number] => ({
  name,
  space: `/work/${name}`,
  visible,
  sessions: [],
})

const model: Omit<Fleet, 'fingerprint' | 'digest'> = {
  builtAt: '2026-11-06T12:00:00.000Z',
  summary: { working: 0, idle: 0, done: 0, asks: 0, staleAsks: 0 },
  asks: [],
  expired: {},
  health: [],
  repos: [repo('app', false), repo('marked', true)],
  unplaced: [],
  errors: [],
  issues: [],
  quota: [],
  queue: { effective: 'run', spawns: [] },
}

test('the feed holds the filed titles of open Issues in ordinary repos, and nothing of IuRoot', () => {
  const scope = scopeOf({
    model,
    merged: [],
    sessions: [],
    isVisible: (path) => path.split('/').includes('IuRoot'),
    issues: [
      { title: 'Fix the login flow', repo: '/work/app' },
      { title: 'Fix the login flow', repo: '/work/other' },
      { title: 'Ticket EP-12 customer data', repo: '/Users/me/IuRoot/portal' },
      { title: 'Marked by the model', repo: '/work/marked' },
    ],
    visibleNames: [],
  })
  // once per text, however many Issues carry it; a repo that is IuRoot's by place or marked visible by the model gives none
  expect(scope.feed.headings).toEqual(['Fix the login flow'])
})

test('with no open Issue the feed has no heading', () => {
  expect(
    scopeOf({ model, merged: [], sessions: [], isVisible: () => false, issues: [], visibleNames: [] }).feed.headings,
  ).toEqual([])
})

const ask = (id: string, text: string, repo: string | null = null): Fleet['asks'][number] => ({
  id,
  kind: 'question',
  repo,
  session: null,
  short: null,
  text,
  source: 'factory',
  at: '2026-11-06T10:00:00.000Z',
})

test("the feed holds the text of an ask or a health line only when nothing of it is IuRoot's", () => {
  const scope = scopeOf({
    model: {
      ...model,
      asks: [
        ask('queue:1', 'Review the iris release notes', null),
        ask('queue:2', 'Check the portal rollout in IuRoot', null),
        ask('factory:3', 'Issue 3 waits on the visible-repo decision', '/work/marked'),
        ask('factory:4', 'Issue 4 waits on a note', '/work/app'),
        ask('factory:5', 'Look at PORTAL-desk again', null),
      ],
      health: [
        {
          id: 'health:a',
          kind: 'machine',
          text: 'spawn x-1 failed in the desk repo',
          repo: null,
          since: '2026-11-06T10:00:00.000Z',
        },
        {
          id: 'health:b',
          kind: 'park',
          text: 'Issue 9 parked',
          repo: '/work/marked',
          since: '2026-11-06T10:00:00.000Z',
        },
      ],
    },
    merged: [],
    sessions: [],
    isVisible: (path) => path.split('/').includes('IuRoot'),
    issues: [],
    visibleNames: ['desk', 'portal', 'ab'],
  })
  expect(scope.feed.lines).toEqual(['Review the iris release notes', 'Issue 4 waits on a note'])
})

test('a text naming a visible repo as part of a longer word is still offered', () => {
  const scope = scopeOf({
    model: { ...model, asks: [ask('queue:1', 'The desktop needs a restart')] },
    merged: [],
    sessions: [],
    isVisible: () => false,
    issues: [],
    visibleNames: ['desk'],
  })
  expect(scope.feed.lines).toEqual(['The desktop needs a restart'])
})
