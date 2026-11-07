-- The change stream: one row per fact that moved, written by triggers in the transaction that moved it. The Console and
-- the Herdr board follow it with a cursor (apps/server/src/read/stream.ts holds the reasoning).
--
-- Requires PostgreSQL 13 or newer: `xid8`, `pg_current_xact_id()` and `pg_snapshot_xmin(pg_current_snapshot())`.
--
-- A row carries no free text of an Issue, only kinds, ids and states, so a frame needs no redaction for the read token.
-- It is derived output: the domains' tables stay the facts. Nothing here alters another domain's table; the triggers
-- only observe them.

CREATE TABLE factory.changes (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- the writing transaction's id: with `seq` the cursor's order, and the key of the "every lower transaction has ended" test
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('issue', 'session', 'decision', 'artifact', 'errand', 'signal')),
  issue_id text,
  -- what happened, in one word (the event kind, the hook kind, asked, answered, raised, done ...)
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX changes_by_txid ON factory.changes (txid, seq);
CREATE INDEX changes_by_issue ON factory.changes (issue_id, txid, seq);

CREATE FUNCTION factory.note_change(p_kind text, p_issue text, p_subject text, p_detail jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO factory.changes (kind, issue_id, subject, detail) VALUES (p_kind, p_issue, p_subject, p_detail);
$$;

-- An Issue's event, applied or not.
CREATE FUNCTION factory.changes_issue_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change('issue', NEW.issue_id, NEW.kind,
    jsonb_build_object('from', NEW.from_state, 'to', NEW.to_state, 'result', NEW.result));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_issue_events AFTER INSERT ON factory.issue_events
  FOR EACH ROW EXECUTE FUNCTION factory.changes_issue_event();

-- A lead's hook event.
CREATE FUNCTION factory.changes_hook_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change('session', NEW.issue_id, NEW.kind,
    jsonb_build_object('session', NEW.session, 'attempt', NEW.attempt));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_lead_hook_events AFTER INSERT ON factory.lead_hook_events
  FOR EACH ROW EXECUTE FUNCTION factory.changes_hook_event();

-- A Decision: asked on insert, answered or withdrawn when that column is set.
CREATE FUNCTION factory.changes_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM factory.note_change('decision', NEW.issue_id, 'asked', jsonb_build_object('decision', NEW.id));
  ELSIF OLD.answered_at IS NULL AND NEW.answered_at IS NOT NULL THEN
    PERFORM factory.note_change('decision', NEW.issue_id, 'answered',
      jsonb_build_object('decision', NEW.id, 'settledBy', NEW.settled_by));
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    PERFORM factory.note_change('decision', NEW.issue_id, 'withdrawn', jsonb_build_object('decision', NEW.id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER changes_decisions AFTER INSERT OR UPDATE ON factory.decisions
  FOR EACH ROW EXECUTE FUNCTION factory.changes_decision();

-- An artifact, its revisions, annotations and verdicts. The Issue of the last three is the artifact's.
CREATE FUNCTION factory.changes_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change('artifact', NEW.issue_id, 'created',
    jsonb_build_object('artifact', NEW.id, 'artifactKind', NEW.kind));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_artifacts AFTER INSERT ON factory.artifacts
  FOR EACH ROW EXECUTE FUNCTION factory.changes_artifact();

CREATE FUNCTION factory.changes_artifact_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_issue text;
  v_detail jsonb;
BEGIN
  SELECT issue_id INTO v_issue FROM factory.artifacts WHERE id = NEW.artifact_id;
  IF TG_TABLE_NAME = 'artifact_revisions' THEN
    v_detail := jsonb_build_object('artifact', NEW.artifact_id, 'revision', NEW.n);
  ELSIF TG_TABLE_NAME = 'verdicts' THEN
    v_detail := jsonb_build_object('artifact', NEW.artifact_id, 'revision', NEW.revision, 'verdict', NEW.verdict);
  ELSE
    v_detail := jsonb_build_object('artifact', NEW.artifact_id, 'revision', NEW.revision, 'annotation', NEW.id);
  END IF;
  PERFORM factory.note_change('artifact', v_issue, TG_ARGV[0], v_detail);
  RETURN NULL;
END $$;
CREATE TRIGGER changes_artifact_revisions AFTER INSERT ON factory.artifact_revisions
  FOR EACH ROW EXECUTE FUNCTION factory.changes_artifact_part('revised');
CREATE TRIGGER changes_verdicts AFTER INSERT ON factory.verdicts
  FOR EACH ROW EXECUTE FUNCTION factory.changes_artifact_part('verdict');
CREATE TRIGGER changes_annotations AFTER INSERT ON factory.annotations
  FOR EACH ROW EXECUTE FUNCTION factory.changes_artifact_part('annotated');

-- An Errand: raised on insert, done when the owner's hands did it.
CREATE FUNCTION factory.changes_errand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM factory.note_change('errand', NEW.issue_id, 'raised', jsonb_build_object('errand', NEW.id));
  ELSIF OLD.done_at IS NULL AND NEW.done_at IS NOT NULL THEN
    PERFORM factory.note_change('errand', NEW.issue_id, 'done', jsonb_build_object('errand', NEW.id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER changes_errands AFTER INSERT OR UPDATE ON factory.errands
  FOR EACH ROW EXECUTE FUNCTION factory.changes_errand();

-- A stored signal: its state is the subject (held, filed, amended, incident, promoted).
CREATE FUNCTION factory.changes_signal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = NEW.state THEN
    RETURN NULL;
  END IF;
  PERFORM factory.note_change('signal', NEW.issue_id, NEW.state, jsonb_build_object('signal', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_intake_signals AFTER INSERT OR UPDATE ON factory.intake_signals
  FOR EACH ROW EXECUTE FUNCTION factory.changes_signal();
