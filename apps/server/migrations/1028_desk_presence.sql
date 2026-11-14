-- Whether the MacBook last answered the ask-human ssh probe, one row. A push or probe that found it unreachable sets `up`
-- false; the probe that finds it answering again sets `back_at`, which the desk pass reads beside the Console's
-- `returned_at` as the owner's return (a MacBook that comes back is a person at it).
CREATE TABLE factory.desk_presence (
  id      boolean     PRIMARY KEY DEFAULT true CHECK (id),
  macbook_up boolean  NOT NULL,
  back_at timestamptz
);
