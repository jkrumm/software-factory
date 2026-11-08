-- Fix commits by class (docs/product.md "Fix classes"): the commits of a project's default branch whose subject is a
-- conventional `fix`, each with the class the rules or `factory-fix-classes` gave it. A fact, written once per commit.
CREATE TABLE factory.fix_commits (
  repo         text        NOT NULL,
  sha          text        NOT NULL,
  committed_at timestamptz NOT NULL,
  subject      text        NOT NULL,
  scope        text,
  class        text        NOT NULL CHECK (class IN ('tests', 'docs', 'tooling', 'review', 'logic', 'contract', 'concurrency', 'environment', 'other')),
  by           text        NOT NULL CHECK (by IN ('rule', 'workflow')),
  reason       text,
  PRIMARY KEY (repo, sha)
);

CREATE INDEX fix_commits_by_time ON factory.fix_commits (committed_at);
