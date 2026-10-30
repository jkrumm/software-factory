-- When a prompt gave up: `factory status` shows a failed prompt for a day from this, not from when it was recorded.
ALTER TABLE factory.prompts ADD COLUMN failed_at timestamptz;
UPDATE factory.prompts SET failed_at = COALESCE(sent_at, created_at) WHERE status = 'failed';
