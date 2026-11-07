-- The way back, as the `factory` role, once the old core's schema is `factory` again and before the old core starts: its
-- Issue numbers continue past every number the new core used, so the two cores never give one number to two Issues.
\set ON_ERROR_STOP on
SELECT setval(
  'factory.issues_id_seq',
  GREATEST(
    (SELECT last_value FROM factory.issues_id_seq),
    (SELECT COALESCE(max(substr(id, 7)::int), 0) FROM factory_rewrite.issues)
  ),
  true
) AS old_issue_numbers_continue_at;
