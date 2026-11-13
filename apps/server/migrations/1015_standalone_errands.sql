-- A standalone Errand: a request for the owner's hands that no Issue raised (`ask-human.sh`, an agent's
-- ask). It has no Issue, no lead and no screen: it reaches the owner at intake. What it carries beyond a lead's Errand is
-- the command to run, a `check` command that exits 0 while it is still needed, an expiry, and a request key that replaces
-- an older open request with the same key.
--
-- `closed_kind` says how any Errand ended once it has: the owner did it (`done`), the owner or the loop found it needless
-- (`not_needed`), it ran past its expiry (`expired`), a newer request replaced it (`superseded`), or the screen refused it
-- (`turned_away`). `closed_by` says who: `owner`, `check` (the loop ran its command), `judge` (the still-needed workflow),
-- `loop` (the expiry), `request` (a newer one). Errands closed before this migration keep both null.

ALTER TABLE factory.errands
  ALTER COLUMN issue_id DROP NOT NULL,
  ALTER COLUMN attempt DROP NOT NULL,
  ADD COLUMN source text,
  ADD COLUMN command text,
  ADD COLUMN check_command text,
  ADD COLUMN host text CHECK (host IN ('macbook', 'iphone', 'portal', 'any')),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN request_key text,
  ADD COLUMN closed_kind text CHECK (closed_kind IN ('done', 'not_needed', 'expired', 'superseded', 'turned_away')),
  ADD COLUMN closed_by text CHECK (closed_by IN ('owner', 'check', 'judge', 'loop', 'request')),
  -- the last run of the check, what it answered, and how many runs in a row could not run
  ADD COLUMN check_at timestamptz,
  ADD COLUMN check_note text,
  ADD COLUMN check_fails integer NOT NULL DEFAULT 0,
  -- the last look of the still-needed workflow (an Errand with no check)
  ADD COLUMN needed_at timestamptz;

-- an Errand with no Issue is a standalone one and says where it came from
ALTER TABLE factory.errands
  ADD CONSTRAINT errands_standalone_source CHECK (issue_id IS NOT NULL OR source IS NOT NULL);

-- one open request per key
CREATE UNIQUE INDEX errands_open_request_key ON factory.errands (request_key)
  WHERE request_key IS NOT NULL AND done_at IS NULL;

CREATE INDEX errands_standalone_open ON factory.errands (raised_at)
  WHERE issue_id IS NULL AND done_at IS NULL;

-- the "Errands closed without you" band reads by close time
CREATE INDEX errands_closed_without_owner ON factory.errands (done_at)
  WHERE closed_by IS NOT NULL AND closed_by <> 'owner';

-- a turned-away Errand is a closed one too
UPDATE factory.errands SET closed_kind = 'turned_away' WHERE turned_away_at IS NOT NULL;
