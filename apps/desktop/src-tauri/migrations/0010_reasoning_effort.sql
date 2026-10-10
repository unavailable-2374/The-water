-- A token reserve controls capacity, not how much deliberation a model performs.
-- NULL leaves existing providers' behavior unchanged.
ALTER TABLE llm_providers ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high'));
