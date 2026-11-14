-- What the throughput rule (the load ceiling in multiples of the cores, a cap on the process count) would have decided in a
-- minute beside the live rule: the first admission look of each minute with an Issue queued that only the host's rules
-- keep out (app/capacity-admit.ts `shadowDecision`). Kept 14 days. `*_refusal` is the refusal kind of the first such Issue,
-- null when it is admitted; `load_ceiling` and `process_cap` are the rules' numbers of that minute.
CREATE TABLE factory.admission_shadow (
  at                  timestamptz      PRIMARY KEY,
  candidates          integer          NOT NULL,
  live_admits         integer          NOT NULL,
  shadow_admits       integer          NOT NULL,
  live_refusal        text,
  shadow_refusal      text,
  shadow_message      text,
  load                double precision,
  load_ceiling        double precision NOT NULL,
  shadow_load_ceiling double precision NOT NULL,
  processes           integer,
  process_cap         integer          NOT NULL
);
