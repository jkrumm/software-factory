import type { SQL } from 'bun'

/** Agent text on the owner's terminal: one line, no control characters, cut short. */
const oneLine = (text: string, max = 160): string => {
  // oxlint-disable-next-line no-control-regex -- exactly what is removed
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const PER_KIND = 10

/**
 * What the owner should look at, one line each, for `factory status`: open questions, Issues a lead parked or blocked, alerts held
 * back by the switch, Issues waiting for their project's claim, and a lead that cannot be started. Lead text is data and is shown cut.
 */
export async function issueAttention(sql: SQL, now: Date, options: { alertLeads: boolean }): Promise<string[]> {
  const lines: string[] = []

  const asks: { issue_id: number; question: string; default_option: string | null; expires_at: Date | null }[] =
    await sql`
    SELECT d.issue_id, d.question, d.default_option, d.expires_at FROM factory.decisions d
    JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.answered_at IS NULL AND i.state <> 'closed' ORDER BY d.id LIMIT ${PER_KIND}`
  for (const ask of asks) {
    const lapsed = ask.expires_at !== null && ask.expires_at <= now && ask.default_option === null
    const parts = [
      ask.default_option ? `default ${oneLine(ask.default_option, 60)}` : null,
      ask.expires_at ? `until ${ask.expires_at.toISOString()}` : null,
    ].filter(Boolean)
    const tail = lapsed ? ' (expired with no default)' : parts.length > 0 ? ` (${parts.join(', ')})` : ''
    lines.push(`Issue ${ask.issue_id} asks: ${oneLine(ask.question)}${tail}`)
  }

  const parked: { id: number; reason: string; since: Date; why: string | null }[] = await sql`
    SELECT i.id, i.reason, i.updated_at AS since,
      (SELECT COALESCE(e.payload->>'reason', e.payload->>'detail') FROM factory.issue_events e
       WHERE e.issue_id = i.id AND e.kind IN ('block', 'lead_gone') ORDER BY e.id DESC LIMIT 1) AS why
    FROM factory.issues i WHERE i.state = 'waiting' AND i.reason IN ('unreported', 'blocked', 'parked', 'lead_gone') ORDER BY i.id LIMIT ${PER_KIND}`
  for (const issue of parked) {
    if (issue.reason === 'unreported')
      lines.push(`Issue ${issue.id} parked: its lead stopped twice with nothing reported`)
    else if (issue.reason === 'lead_gone')
      lines.push(`Issue ${issue.id} parked: its lead is gone${issue.why ? ` (${oneLine(issue.why)})` : ''}`)
    else if (issue.reason === 'blocked')
      lines.push(`Issue ${issue.id} blocked${issue.why ? `: ${oneLine(issue.why)}` : ''}`)
    else lines.push(`Issue ${issue.id} parked`)
  }

  if (!options.alertLeads) {
    const alerts: { id: number }[] = await sql`
      SELECT id FROM factory.issues WHERE state = 'queued' AND source = 'alert' ORDER BY id LIMIT ${PER_KIND}`
    for (const alert of alerts)
      lines.push(`Issue ${alert.id} is an alert and starts no lead: FACTORY_ALERT_LEADS is not set`)
  }

  const waiting: { id: number; project: string }[] = await sql`
    SELECT i.id, substr(c.key, 6) AS project FROM factory.issues i JOIN factory.claims c ON c.issue_id = i.id
    WHERE i.state = 'queued' AND c.held_at IS NULL ORDER BY i.id LIMIT ${PER_KIND}`
  for (const issue of waiting) lines.push(`Issue ${issue.id} waits for the claim on ${issue.project}`)

  const stuck: { issue_id: number; error: string }[] = await sql`
    SELECT e.issue_id, e.error FROM factory.issue_effects e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.kind = 'start_lead' AND e.done_at IS NULL AND e.cancelled_at IS NULL AND e.error IS NOT NULL AND i.state <> 'closed'
    ORDER BY e.id LIMIT ${PER_KIND}`
  for (const effect of stuck) lines.push(`Issue ${effect.issue_id}: its lead did not start: ${oneLine(effect.error)}`)

  const trees: { issue_id: number; tries: number; error: string }[] = await sql`
    SELECT w.issue_id, w.tries, w.error FROM factory.lead_worktrees w JOIN factory.issues i ON i.id = w.issue_id
    WHERE w.status = 'pending' AND w.error IS NOT NULL AND i.state <> 'closed' ORDER BY w.first_at LIMIT ${PER_KIND}`
  for (const tree of trees) {
    lines.push(
      `Issue ${tree.issue_id}: its worktree could not be made (try ${tree.tries}), trying again: ${oneLine(tree.error)}`,
    )
  }

  return lines
}
