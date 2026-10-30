-- Quota readings from the account picker, one row per account per poll. Percentages are of the window; a null is "the
-- picker has no sample". `sampled_at` is when the sample behind the row was taken (read_at minus its age): a spawn
-- assigned after it is not in the numbers yet. Replaces capacity_readings, which stays for one release and is no
-- longer written.
CREATE TABLE factory.quota_readings (
  id                  bigserial PRIMARY KEY,
  account             text NOT NULL,
  read_at             timestamptz NOT NULL,
  sampled_at          timestamptz,
  enabled             boolean NOT NULL,
  auth_ok             boolean NOT NULL,
  five_hour_used      double precision,
  weekly_used         double precision,
  five_hour_resets_at timestamptz,
  weekly_resets_at    timestamptz,
  exhausted_until     timestamptz
);
CREATE INDEX quota_readings_latest ON factory.quota_readings (account, id DESC);

-- Queue state per scope: project is the repo path, initiative is for F4 (null until then). Both null is the global
-- scope. No row means `run`.
CREATE TABLE factory.queue_states (
  id         bigserial PRIMARY KEY,
  project    text,
  initiative text,
  state      text NOT NULL CHECK (state IN ('run', 'pace', 'drain')),
  set_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX queue_states_scope ON factory.queue_states ((COALESCE(project, '')), (COALESCE(initiative, '')));

-- What a spawn is: its role and the tier and effort the role table gave it when it was queued, when its account was
-- assigned (a reading sampled earlier does not show it), and why it is held although it may have capacity.
-- The defaults keep a previous release's inserts valid.
ALTER TABLE factory.spawns ADD COLUMN role text NOT NULL DEFAULT 'worker';
ALTER TABLE factory.spawns ADD COLUMN tier text NOT NULL DEFAULT 'sonnet';
ALTER TABLE factory.spawns ADD COLUMN effort text NOT NULL DEFAULT 'high';
ALTER TABLE factory.spawns ADD COLUMN assigned_at timestamptz;
ALTER TABLE factory.spawns ADD COLUMN hold text CHECK (hold IN ('drain', 'pace', 'wave'));
