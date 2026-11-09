-- The owner edits the comment of an annotation or deletes the annotation. An edit stamps `edited_at`; a delete removes the
-- row. Both reach the change stream like 'annotated' does (the artifact's Issue, the annotation's id).

ALTER TABLE factory.annotations ADD COLUMN edited_at timestamptz;

CREATE FUNCTION factory.changes_annotation_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_issue text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT issue_id INTO v_issue FROM factory.artifacts WHERE id = OLD.artifact_id;
    PERFORM factory.note_change('artifact', v_issue, 'annotation_deleted',
      jsonb_build_object('artifact', OLD.artifact_id, 'revision', OLD.revision, 'annotation', OLD.id));
    RETURN NULL;
  END IF;
  SELECT issue_id INTO v_issue FROM factory.artifacts WHERE id = NEW.artifact_id;
  PERFORM factory.note_change('artifact', v_issue, 'annotation_edited',
    jsonb_build_object('artifact', NEW.artifact_id, 'revision', NEW.revision, 'annotation', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_annotations_edited AFTER UPDATE OF comment ON factory.annotations
  FOR EACH ROW WHEN (OLD.comment IS DISTINCT FROM NEW.comment) EXECUTE FUNCTION factory.changes_annotation_edit();
CREATE TRIGGER changes_annotations_deleted AFTER DELETE ON factory.annotations
  FOR EACH ROW EXECUTE FUNCTION factory.changes_annotation_edit();
