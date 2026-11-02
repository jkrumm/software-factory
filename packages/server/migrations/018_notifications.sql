-- The notifier's outbox (docs/design.md §11, "The owner's line"). A rule inserts a row in the transaction that decides it; the tick
-- sends unsent rows outside any transaction. `key` is the deterministic name of the message (`notify:<kind>:...`), so a replayed rule
-- inserts nothing. `next_at` is when the row is next due: the backoff after a failed send, and the lease while a send is in flight (a
-- crash between the send and its record is found again once it runs out: at-least-once). `failed_at` is set when the attempts are spent.
-- Additive: a rollback to the previous release ignores it.
CREATE TABLE factory.notifications (
  key        text PRIMARY KEY,
  kind       text NOT NULL,
  issue_id   integer REFERENCES factory.issues (id),
  text       text NOT NULL,
  created_at timestamptz NOT NULL,
  next_at    timestamptz NOT NULL,
  sent_at    timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  error      text,
  failed_at  timestamptz,
  CHECK (sent_at IS NULL OR failed_at IS NULL)
);
CREATE INDEX notifications_due ON factory.notifications (next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE INDEX notifications_recent ON factory.notifications (created_at DESC);
