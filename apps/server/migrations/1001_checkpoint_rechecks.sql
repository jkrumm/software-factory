-- A checkpoint that stayed in front of the owner past the recheck setting is looked at once more. Each look is a fact:
-- what it found (`withdrawn`: the Issue moved past it; `settled`: the Judge answered it or turned it away; `kept`: it
-- still needs him), who found it, and how far the Issue's log had come (`through_version`). The next look needs an Issue
-- event beyond that version, so nothing is checked twice without news. Whether a checkpoint is due is derived from these
-- rows and the Issue's log, never stored.

CREATE TABLE factory.checkpoint_rechecks (
  checkpoint_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decision', 'errand')),
  issue_id text NOT NULL REFERENCES factory.issues (id),
  through_version integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('withdrawn', 'settled', 'kept')),
  by text NOT NULL CHECK (by IN ('factory', 'judge')),
  reason text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (checkpoint_id, through_version)
);

CREATE INDEX checkpoint_rechecks_by_issue ON factory.checkpoint_rechecks (issue_id, at);

-- One change per look, for the readers of the stream ("Since you were here").
CREATE FUNCTION factory.changes_checkpoint_recheck() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change(NEW.kind, NEW.issue_id, 'rechecked',
    jsonb_build_object(NEW.kind, NEW.checkpoint_id, 'outcome', NEW.outcome));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_checkpoint_rechecks AFTER INSERT ON factory.checkpoint_rechecks
  FOR EACH ROW EXECUTE FUNCTION factory.changes_checkpoint_recheck();
