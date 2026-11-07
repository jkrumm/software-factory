-- Rules that act (F1 Wave 4). Additive: a rollback to the previous release ignores all of it.

-- Who started a spawn, from the FACTORY_SESSION of the caller: the send-back rule counts a session's live children,
-- the blocked rule tells the parent. And the account a session runs on, from the hook (CLAUDE_ACCOUNT_PICKED), for
-- sessions `rd` starts, which have no spawn row to read it from.
ALTER TABLE factory.spawns ADD COLUMN parent text;
ALTER TABLE factory.sessions ADD COLUMN account text;
CREATE INDEX spawns_parent ON factory.spawns (parent) WHERE parent IS NOT NULL;

-- Text typed into a session. `id` is the idempotency key: a rule's key (resume:<session>:<reset_at>) or a note's own
-- id, so recording the same prompt twice stores it once.
--   pending:   recorded, held until the session can take it (`next_at` has passed, the session is not working)
--   typing:    claimed by a tick, the Runner call is in flight (a claim older than the lease counts as sent)
--   sent:      typed; waits for the next turn_started to prove it arrived
--   delivered: a turn_started followed
--   failed:    given up (`error` says why); stays in `factory status` for a day
-- `via` is how it gets there: typed into the pane, or by resuming the session by id (herdr restart).
CREATE TABLE factory.prompts (
  id           text PRIMARY KEY,
  session      text NOT NULL,
  source       text NOT NULL,
  via          text NOT NULL CHECK (via IN ('type', 'resume')),
  text         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'typing', 'sent', 'delivered', 'failed')),
  created_at   timestamptz NOT NULL,
  next_at      timestamptz NOT NULL,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  sent_count   integer NOT NULL DEFAULT 0,
  failures     integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  error        text
);
CREATE INDEX prompts_open ON factory.prompts (session) WHERE status IN ('pending', 'typing', 'sent');

-- Effects of a rule that are not typed text (the send-back): the key makes a replay a no-op.
CREATE TABLE factory.effects (
  key     text PRIMARY KEY,
  rule    text NOT NULL,
  session text NOT NULL,
  at      timestamptz NOT NULL,
  detail  jsonb
);
