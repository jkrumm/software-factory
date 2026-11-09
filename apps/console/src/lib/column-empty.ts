/** Why a column is empty and what puts a card there: the empty board says it in place of "Nothing here". */
export const COLUMN_EMPTY: Record<
  'settling' | 'queued' | 'working' | 'waiting' | 'watching' | 'closed',
  { title: string; cause: string }
> = {
  settling: { title: 'Nothing is settling', cause: 'A new Issue sits here until triage has settled it.' },
  queued: { title: 'Nothing is queued', cause: 'A settled Issue waits here while capacity or a chain holds it back.' },
  working: { title: 'No lead is working', cause: 'An Issue shows here while a lead runs on it.' },
  waiting: {
    title: 'Nothing is waiting',
    cause: 'An Issue shows here while it waits on a Decision, an Errand or a review.',
  },
  watching: {
    title: 'Nothing is being watched',
    cause: 'A shipped, deployed Issue shows here until Verify and the probes pass.',
  },
  closed: {
    title: 'Nothing closed lately',
    cause: 'An Issue shows here for a while after it is done, dropped or cancelled.',
  },
}
