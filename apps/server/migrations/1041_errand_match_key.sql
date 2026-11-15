-- What makes two Errands the same need (`domains/checkpoints/match.ts`): a lead's own need key, the normalised command, or the
-- normalised one-line ask in the same repo. A second Issue that raises an open Errand's key waits on that Errand (an
-- `errand_joins` row) instead of paging the owner again. Errands raised before it carry none and still join by exact command
-- or check.
ALTER TABLE factory.errands ADD COLUMN match_key text;
CREATE INDEX errands_open_match_key ON factory.errands (match_key) WHERE done_at IS NULL AND match_key IS NOT NULL;
