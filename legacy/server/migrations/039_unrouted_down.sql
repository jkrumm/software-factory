-- An unrouted monitor that stays down reaches someone (docs/design.md §11 "Unrouted monitors"). Additive: a rollback to the previous
-- release ignores all of it (it writes rows with a NULL status, which nothing here reads as down).

-- `status` is the monitor's last known state, NULL when the row predates this column and nothing says; `down_since` is when the current
-- down began (an `up` clears it, so a long down keeps its line without a transition event); `is_group` marks a group monitor (Kuma's
-- 'Child monitors down'), which never files anything; `filed_at` / `filed_issue` / `file_error` are the steward's filing of the down.
ALTER TABLE factory.door_unrouted
  ADD COLUMN status      text,
  ADD COLUMN down_since  timestamptz,
  ADD COLUMN is_group    boolean NOT NULL DEFAULT false,
  ADD COLUMN filed_at    timestamptz,
  ADD COLUMN filed_issue integer,
  ADD COLUMN file_error  text;

-- The parsers title an alert `<name> is down[: <detail>]`: the rows already there can be read the same way.
UPDATE factory.door_unrouted
SET status = CASE WHEN last_title ~ ' is down(: |$)' THEN 'down' ELSE 'up' END,
    is_group = last_title ~* 'child monitors? down';
UPDATE factory.door_unrouted SET down_since = last_seen WHERE status = 'down';
