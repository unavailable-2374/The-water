-- 用量与费用统计（§2.1 第 3 条）。
--
-- token 用量原本只逐条散落在 chapter_versions.usage / ai_messages.usage 里，
-- 既算不出「这本书花了多少钱」，也算不出「这个月花了多少钱」。这里补两张表：
--
--   usage_events —— 每次 LLM 调用一行，带上归属（小说 / 任务 / 步骤 / 会话）、
--                    用途、模型、token 数，以及**记账当时**换算出的费用快照。
--                    费用存快照而不是每次现算，是因为价格表允许用户随时改，
--                    改价不应该让历史账单跟着变。
--   model_prices  —— 单位价格覆盖表。内置价格写在 src/novel/pricing.ts，
--                    这张表只存用户改过的那几条（source = 'user'），
--                    读取时与内置表按 id 合并，用户条目优先。

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  novel_id TEXT,
  job_id TEXT,
  step_id TEXT,
  conversation_id TEXT,
  -- writing / planning / summarize / styleReview / consistency / extractStyle / chat
  purpose TEXT NOT NULL DEFAULT 'writing',
  provider_id TEXT,
  provider_kind TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- 记账当时按 model_prices + 汇率折算出的人民币金额（元）。
  cost_cny REAL NOT NULL DEFAULT 0,
  -- 命中的价格条目 id，便于事后核账；没有价格时为空。
  price_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_novel ON usage_events(novel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events(job_id);
CREATE INDEX IF NOT EXISTS idx_usage_step ON usage_events(step_id);

CREATE TABLE IF NOT EXISTS model_prices (
  -- `${providerKind}:${model}`，全部小写。
  id TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  input_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY','USD')),
  updated_at INTEGER NOT NULL
);
