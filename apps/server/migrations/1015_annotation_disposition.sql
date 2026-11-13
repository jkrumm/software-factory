-- A lead answers each of the owner's annotations: applied, deferred (naming the Issue or signal it filed) or declined
-- (naming the reason). The answer sits on the annotation and reaches the change stream like an edit does.

ALTER TABLE factory.annotations
  ADD COLUMN disposition text CHECK (disposition IN ('applied', 'deferred', 'declined')),
  ADD COLUMN disposition_note text,
  ADD COLUMN disposed_at timestamptz;

CREATE FUNCTION factory.changes_annotation_disposed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_issue text;
BEGIN
  SELECT issue_id INTO v_issue FROM factory.artifacts WHERE id = NEW.artifact_id;
  PERFORM factory.note_change('artifact', v_issue, 'annotation_disposed',
    jsonb_build_object('artifact', NEW.artifact_id, 'revision', NEW.revision, 'annotation', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_annotations_disposed AFTER UPDATE OF disposition, disposition_note ON factory.annotations
  FOR EACH ROW WHEN (OLD.disposition IS DISTINCT FROM NEW.disposition OR OLD.disposition_note IS DISTINCT FROM NEW.disposition_note)
  EXECUTE FUNCTION factory.changes_annotation_disposed();
