/**
 * The screens in the order of the owner's day: where things stand, what wants him, what depends on what, the projects,
 * what there is to read; then the quieter group of how well the factory works. `key` is the second key of the `g` chord;
 * `purpose` is the one question the screen answers, shown under its title (DESIGN.md "The screens" holds the same words).
 * Plain data with no React or icon import, so the tests and the key list read it as it is; `nav.ts` adds the icons.
 */
export const SCREENS = [
  {
    to: '/',
    label: 'Overview',
    key: 'O',
    group: 'work',
    purpose: 'Where does the factory stand right now, and what needs me first?',
  },
  {
    to: '/needs-you',
    label: 'Needs you',
    key: 'N',
    group: 'work',
    purpose: 'What wants my answer, my review or my hands?',
  },
  {
    to: '/chain',
    label: 'Chain',
    key: 'C',
    group: 'work',
    purpose: 'What depends on what, and what holds the next step back?',
  },
  {
    to: '/projects',
    label: 'Projects',
    key: 'P',
    group: 'work',
    purpose: 'How is each project doing, and what runs, ships and comes next in it?',
  },
  {
    to: '/artifacts',
    label: 'Artifacts',
    key: 'A',
    group: 'work',
    purpose: 'Which Concepts, Specs and Reports are there to read or to judge?',
  },
  {
    to: '/improve',
    label: 'Improve',
    key: 'I',
    group: 'insight',
    purpose: 'Is the factory getting better against its targets, and where does it fall short?',
  },
  {
    to: '/throughput',
    label: 'Throughput',
    key: 'T',
    group: 'insight',
    purpose: 'Is the host the limit, and what holds the queue back?',
  },
] as const satisfies ReadonlyArray<{
  to: string
  label: string
  key: string
  group: 'work' | 'insight'
  purpose: string
}>

export type Screen = (typeof SCREENS)[number]
export type ScreenTarget = Screen['to']

/** The question a screen answers, shown under its title; undefined for a title that is no screen of the navigation. */
export const purposeOfLabel = (label: string): string | undefined =>
  SCREENS.find((screen) => screen.label === label)?.purpose
