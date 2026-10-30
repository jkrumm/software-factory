-- One herdr space per repo (F1 Wave 5). Additive: a rollback to the previous release ignores all of it.

-- Where a spawn's tab goes: the space is a path (defaults to the repo); `new_space` asks for a space of its own even if
-- the path already has one. The tab and workspace are what the Runner made or found, recorded when the spawn starts.
ALTER TABLE factory.spawns ADD COLUMN space text;
ALTER TABLE factory.spawns ADD COLUMN new_space boolean NOT NULL DEFAULT false;
ALTER TABLE factory.spawns ADD COLUMN tab text;
ALTER TABLE factory.spawns ADD COLUMN workspace text;

-- A session's tab (a spawn's from the Runner, an `rd` session's from HERDR_TAB_ID in the hook), and the role a session
-- carries that no spawn row describes (FACTORY_ROLE in the pane, reported by session-start).
ALTER TABLE factory.sessions ADD COLUMN tab text;
ALTER TABLE factory.sessions ADD COLUMN role text;
