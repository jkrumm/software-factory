-- F2 Wave 3: classify and the lead (docs/design.md §4, §5, §12). Additive: a rollback to the previous release ignores all of it.

-- What Classify answered, stored on the Issue (`kind` and `class` already exist). `lead_tier` and `lead_effort` are the lead's, after
-- the role table's ceiling; `classify` keeps the whole answer as it came (its `project` and `reason` too) and what was clamped.
-- `classified_at` is set once classify has run for the Issue, whether it answered or fell back to defaults: an Issue is admitted only after.
ALTER TABLE factory.issues
  ADD COLUMN size          text,
  ADD COLUMN lead_tier     text,
  ADD COLUMN lead_effort   text,
  ADD COLUMN classify      jsonb,
  ADD COLUMN classified_at timestamptz;
