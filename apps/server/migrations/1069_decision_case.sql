-- A Decision is one question with its case (docs/language.md, Decision): the class that makes it the owner's, the line that says
-- why, an optional exhibit that shows the change, and the Spec behind it. Expand only: four nullable columns; a Decision asked
-- before keeps null in each. An option's leadsTo lives in the options document, absent on the old rows.

ALTER TABLE factory.decisions
  ADD COLUMN class text,
  ADD COLUMN why_yours text,
  ADD COLUMN exhibit jsonb,
  ADD COLUMN spec_id text REFERENCES factory.artifacts (id);
