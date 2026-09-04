-- 供应商运行时参数：请求超时、代理与并发。
-- 首字节超时防止供应商建立 SSE 连接后不发数据；空闲超时防止流中途静默断开。
ALTER TABLE llm_providers ADD COLUMN first_byte_timeout_ms INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE llm_providers ADD COLUMN idle_timeout_ms INTEGER NOT NULL DEFAULT 90000;
ALTER TABLE llm_providers ADD COLUMN proxy_url TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_providers ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1;
