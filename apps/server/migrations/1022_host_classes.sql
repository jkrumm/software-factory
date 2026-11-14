-- The host loop's class snapshot (app/loops/host.ts, domains/capacity/classes.ts): every process of the minute's `top`
-- is given a class (lead, step, tenant, factory, system, owner, other) and stored summed per class, repo, tenant, Issue
-- and step; the largest processes are kept beside. Minute rows are kept 14 days, hourly rollups 400 days.

-- Host signals of the minute, null when unreadable: kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical),
-- the memory the compressor holds (vm.compressor_bytes_used), the process count and CPU idle of the `top` header, the
-- free space of the swap volume, and the CPU the collector's own child processes (top, ps, lsof, launchctl) took.
ALTER TABLE factory.host_samples ADD COLUMN pressure_level smallint;
ALTER TABLE factory.host_samples ADD COLUMN compressor_mib integer;
ALTER TABLE factory.host_samples ADD COLUMN processes integer;
ALTER TABLE factory.host_samples ADD COLUMN cpu_idle_pct double precision;
ALTER TABLE factory.host_samples ADD COLUMN vm_free_gib double precision;
ALTER TABLE factory.host_samples ADD COLUMN collector_cpu_ms integer;

-- One row per class, repo, tenant, Issue and step of a minute. `footprint_mib` is the summed physical footprint (top's
-- MEM); `cpu_ms` the CPU time its processes took since the last snapshot (null at the first snapshot after a start; a
-- process that ended between two snapshots is not counted). `repo` and `issue` are a lead's or a step's, `tenant` a
-- tenant's launchd label or `vm:<instance>`, `step` the slot run's name without the lead's prefix.
CREATE TABLE factory.host_class_samples (
  at            timestamptz NOT NULL,
  class         text        NOT NULL CHECK (class IN ('lead', 'step', 'tenant', 'factory', 'system', 'owner', 'other')),
  repo          text,
  tenant        text,
  issue         integer,
  step          text,
  footprint_mib integer     NOT NULL,
  cpu_ms        bigint,
  procs         integer     NOT NULL
);
CREATE INDEX host_class_samples_at ON factory.host_class_samples (at);

-- The minute's notable processes: the 15 largest by footprint (`top`), any over 1 GiB (`large`), any grown by 200 MiB
-- or more within 10 minutes (`growth`, with `grown_mib`). The program name only, never the command line.
CREATE TABLE factory.host_process_samples (
  at            timestamptz NOT NULL,
  pid           integer     NOT NULL,
  ppid          integer     NOT NULL,
  name          text        NOT NULL,
  class         text        NOT NULL CHECK (class IN ('lead', 'step', 'tenant', 'factory', 'system', 'owner', 'other')),
  repo          text,
  tenant        text,
  issue         integer,
  footprint_mib integer     NOT NULL,
  cpu_ms        bigint,
  why           text        NOT NULL CHECK (why IN ('top', 'large', 'growth')),
  grown_mib     integer,
  PRIMARY KEY (at, pid)
);

-- Hourly rollups of the class rows per class, repo and tenant ('' for none): the sum of the minutes' footprints (MiB
-- minutes; over 60 it is the hour's mean), the largest minute, the CPU seconds and the minutes the key was present.
CREATE TABLE factory.host_class_hours (
  hour        timestamptz      NOT NULL,
  class       text             NOT NULL,
  repo        text             NOT NULL DEFAULT '',
  tenant      text             NOT NULL DEFAULT '',
  mib_minutes bigint           NOT NULL,
  peak_mib    integer          NOT NULL,
  cpu_seconds double precision NOT NULL,
  minutes     integer          NOT NULL,
  PRIMARY KEY (hour, class, repo, tenant)
);
