-- A collection: a named set of artifacts with one lead page (the overview), pinned to lead the Artifacts screen or left
-- below it. An artifact belongs to at most one, so the membership is a column on the artifact, not a table. `pinned_at` is
-- a fact: the pin is its presence. Nothing is deleted by taking a page out of a collection. Expand only.

CREATE TABLE factory.artifact_collections (
  id               text        PRIMARY KEY,
  key              text        NOT NULL UNIQUE,
  title            text        NOT NULL,
  repo             text        NOT NULL,
  lead_artifact_id text        REFERENCES factory.artifacts (id),
  pinned_at        timestamptz,
  created_at       timestamptz NOT NULL
);

ALTER TABLE factory.artifacts ADD COLUMN collection_id text REFERENCES factory.artifact_collections (id);
CREATE INDEX artifacts_by_collection ON factory.artifacts (collection_id) WHERE collection_id IS NOT NULL;

-- The change stream (0800): a collection made, retitled, pinned or given a page, and an artifact put in or taken out.
CREATE FUNCTION factory.changes_artifact_collection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change('artifact', NULL, 'collection', jsonb_build_object('collection', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_artifact_collections AFTER INSERT OR UPDATE ON factory.artifact_collections
  FOR EACH ROW EXECUTE FUNCTION factory.changes_artifact_collection();

CREATE FUNCTION factory.changes_artifact_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM factory.note_change('artifact', NEW.issue_id, 'collection', jsonb_build_object('artifact', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER changes_artifact_membership AFTER UPDATE OF collection_id ON factory.artifacts
  FOR EACH ROW WHEN (OLD.collection_id IS DISTINCT FROM NEW.collection_id)
  EXECUTE FUNCTION factory.changes_artifact_membership();
