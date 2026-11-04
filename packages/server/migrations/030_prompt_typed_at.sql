-- When the runner answered `typed` for a prompt: the text is known to be in the pane. The retry of a typed prompt presses Enter only
-- if this is set; after an uncertain typing (or a claim left `typing`) the text is typed again. Expand only: the previous release
-- ignores the column and never writes it.
ALTER TABLE factory.prompts ADD COLUMN typed_at timestamptz;
