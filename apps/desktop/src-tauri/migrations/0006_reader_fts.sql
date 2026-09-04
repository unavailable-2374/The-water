-- 阅读器全文检索：FTS5 + 二元切分（bigram）。
-- SQLite 自带分词器对中文都不好用：unicode61 把整串汉字当成一个词，trigram 又要求查询至少三个字，
-- 中文里最常见的双字词就搜不到。所以入库前由 src/documents/fts.ts 先做二元切分
-- （「中国人民」→「中国 国人 人民 民」），再交给 unicode61 分词；查询时拼成短语查询，
-- 要求这些 bigram 连续出现，等价于子串匹配，不会有二元切分常见的假命中。
--
-- body 存的是切分后的 token 串，不是原文；原文仍在 document_pages.text，
-- 片段、命中位置与页内高亮都从那里算。doc_id / page_no 不参与分词，只用于过滤与回连。

CREATE VIRTUAL TABLE IF NOT EXISTS document_pages_fts USING fts5(
  doc_id UNINDEXED,
  page_no UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
