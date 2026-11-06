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
  })
  // once per text, however many Issues carry it; a repo that is IuRoot's by place or marked visible by the model gives none
  expect(scope.feed.headings).toEqual(['Fix the login flow'])
})

test('with no open Issue the feed has no heading', () => {
  expect(scopeOf({ model, merged: [], sessions: [], isVisible: () => false, issues: [] }).feed.headings).toEqual([])
})
