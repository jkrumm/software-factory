-- Test slots (FL7): a host-wide semaphore around `make check` and test runs. One row per caller, keyed by the id the
-- caller chose. A row without a `slot` is a waiter (kept alive by its polls, served oldest first); a row with one holds
-- it until `leased_until`, which the holder renews while its command runs. Expired rows are removed on the next call.
CREATE TABLE factory.slots (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  requested_at timestamptz NOT NULL,
  seen_at      timestamptz NOT NULL,
  slot         integer UNIQUE,
  leased_until timestamptz,
  CHECK ((slot IS NULL) = (leased_until IS NULL))
);
