import type { SQL } from 'bun'

/** The project the project-page tests read: `argo` has open Issues and a digest from the other seeds, and gets a hygiene history and a monitor here. */
export const PROJECT = 'argo'
/** What `argo`'s project.yaml declares for the hygiene loop (global-setup.ts): one probe of its own, one built-in opted out of, with its reason. */
export const ARGO_PROJECT_YAML = `apiVersion: factory/v2
name: ${PROJECT}
hygiene:
  skip:
    - probe: browser
      reason: argo has no UI
  probes:
    - name: bundle
      target: bundle-size
`
export const BROKEN_LINKS = 'Hygiene: broken links in docs/guide.md'

const HOUR = 3_600_000

/**
 * Two hygiene passes of `argo` as the loop stores them (the loop is off in the e2e world): an older clean one and the newest,
 * with a built-in probe that found, one that is clean, its declared probe red and left out by the cap, a finding intake
 * refused and one the document judgment filed. Plus the monitor route the door holds for it.
 */
export async function seedProjectPage(sql: SQL, now = new Date()): Promise<void> {
  const pass = (
    id: string,
    at: Date,
    report: object,
    filed: object[],
    overBudget: object[],
    failed: object[],
    judgment = { outcome: 'answered', attempts: 1, judgedAt: null, reason: 'read 3 documents', findings: [] },
  ) =>
    sql`INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed)
      VALUES (${id}, ${PROJECT}, ${at}, ${'a'.repeat(40)}, ${JSON.stringify(report)}::text::jsonb, ${JSON.stringify(judgment)}::text::jsonb,
        ${JSON.stringify(filed)}::text::jsonb, ${JSON.stringify(overBudget)}::text::jsonb, ${JSON.stringify(failed)}::text::jsonb)`
  await pass(
    'hygiene_e2e_old',
    new Date(now.getTime() - 8 * 24 * HOUR),
    {
      ref: 'b'.repeat(40),
      runs: [{ probe: 'check', outcome: 'clean', detail: 'make check, 41s, exit 0' }],
      findings: [],
      stale: [],
      slop: [],
    },
    [],
    [],
    [],
    { outcome: 'skipped', attempts: 1, judgedAt: null, reason: 'nothing to judge', findings: [] },
  )
  await pass(
    'hygiene_e2e_new',
    new Date(now.getTime() - 20 * HOUR),
    {
      ref: 'a'.repeat(40),
      runs: [
        { probe: 'check', outcome: 'clean', detail: 'make check, 52s, exit 0' },
        { probe: 'links', outcome: 'found', detail: '1 file with broken links' },
        { probe: 'deps', outcome: 'clean', detail: 'no outdated package' },
        { probe: 'retired', outcome: 'skipped', detail: 'no retired words listed' },
        { probe: 'probe', outcome: 'found', detail: 'bundle: make bundle-size, 3s, exit 1' },
      ],
      findings: [
        { probe: 'links', key: 'links:docs/guide.md', title: BROKEN_LINKS, lines: [], count: 3 },
        { probe: 'probe', key: 'probe:bundle', title: 'Hygiene: project probe bundle is red', lines: [], count: 1 },
        { probe: 'runrules', key: 'runrules', title: 'Hygiene: a run rule is broken', lines: [], count: 2 },
      ],
      stale: [{}, {}, {}],
      slop: [{}],
    },
    [
      { key: 'links:docs/guide.md', title: BROKEN_LINKS },
      { key: 'judgment:docs/ops.md', title: 'Hygiene: docs/ops.md names a removed command' },
    ],
    [{ key: 'probe:bundle', title: 'Hygiene: project probe bundle is red' }],
    [{ key: 'runrules', reason: 'intake refused the signal' }],
  )
  await sql`INSERT INTO factory.intake_door_routes (source, monitor, repo, quiet, last_event)
    VALUES ('kuma', 'argo web', ${PROJECT}, 3, 'up') ON CONFLICT (source, monitor) DO NOTHING`
}
