# The-Water：AI 阅读器 + 小说工坊 实施方案

## Context

`/Users/caoshuo/The-Water` 是一个空目录，需要从零搭建一个产品，包含四块能力：

1. **PDF 阅读**：导入 PDF，选词/选段后与 AI 讨论，做笔记与高亮。
2. **一键生成小说**：用户给框架、字数（1 万到 30 万字）和具体要求，系统分章后台生成。
3. **一键改写**：每本小说有一条可编辑的"故事线"（人物、设定、故事弧、情节点、章节计划），用户随意改动后触发受影响章节的重写。
4. **公共区域**：作者把小说上传到云端公共区；读者可阅读，也可"二创"——把小说 fork 到本地库，用功能 3 改写后再发布，带溯源。
5. **社区（第五期）**：公开身份（@用户名与作者主页）、关注与屏蔽、动态流、留言、站外分享、积分等级与榜单。

用户已做的决策（2026-09-01 确认）：

| 决策点 | 选择 |
|---|---|
| 产品形态 | 桌面应用（Tauri 2）+ 独立云端公共区服务 |
| AI 供应商 | 多供应商可切换；默认 DeepSeek（本机已有 `DEEPSEEK_API_KEY`），兼容 OpenAI 协议的 Qwen/Kimi/OpenAI，另加 Anthropic 原生协议 |
| 数据库 | 先 SQLite 本机跑；服务端用 Drizzle 保证可切 Postgres |
| 小说篇幅 | 中长篇：大纲 → 章节表 → 逐章后台生成，可暂停/续写/重生成 |

本机环境：macOS arm64，Node 25.6、Bun 1.3.12、Rust 1.96 stable、Xcode 已装、SQLite 3.51。无 Docker、无 Postgres。

> 全局 CLAUDE.md 里的 Platform Atlas / Pi 平台约束属于 `~/pi-platform` 仓库，本项目是独立新仓库，不适用。

---

## 一、总体架构

```
The-Water/                      bun workspaces 单仓
├─ packages/shared/             zod schema + 纯函数（两端共用，无构建步骤）
├─ apps/desktop/                Tauri 2 + React 19 + Vite + TS（所有业务逻辑在 TS）
│  └─ src-tauri/                Rust：仅插件 + ~60 行 keychain 命令 + SQL 迁移
└─ apps/server/                 Bun + Hono + Drizzle(bun:sqlite)，公共区 REST API + 极简网页阅读
```

**关键技术选择（已定，不再讨论）**

| 主题 | 选择 | 理由 |
|---|---|---|
| 桌面 DB | `@tauri-apps/plugin-sql` + 手写 SQL 迁移（Rust `include_str!` 注册）+ TS 仓储层 | 查询都是 CRUD；Drizzle sqlite-proxy 不支持事务且多一层 codegen |
| 密钥 | macOS Keychain（`keyring` crate，3 个 Tauri 命令）；开发期回落读 `DEEPSEEK_API_KEY` 环境变量 | 明文 JSON 存 API key 不可接受 |
| LLM HTTP | `@tauri-apps/plugin-http` 的 `fetch`（走 reqwest，支持流式 body + AbortSignal） | 绕开 CORS；不引入 openai / anthropic SDK，自写 ~60 行 SSE 解析器 |
| 前端状态 | Zustand 5 分域 slice；任务 runner 与 LLM registry 是模块级单例 | runner 必须活在 React 树之外 |
| PDF | `pdfjs-dist` 6.x，module worker，文件经 `convertFileSrc` 以 asset 协议按 range 读取 | 不整份读进内存 |
| UI | Tailwind 4 + `lucide-react` + `react-router` 7（hash router），自写基础组件；章节编辑器 v1 用自增高 textarea | 少依赖 |
| 服务端运行时 | Bun（内置 `bun:sqlite`、`Bun.password` argon2id、`Bun.sql` 未来直连 PG、`bun test`） | 零原生依赖；切 PG 不加包 |
| 测试 | desktop + shared 用 vitest（Node 环境，DB 替身用 `node:sqlite` 实现同一 `Db` 接口）；server 用 `bun test` + `hono/testing` | server 依赖 bun:sqlite，vitest 跑不了 |

**已核对的依赖版本（2026-09-01 `npm view`，安装前再 `npm view <pkg> version` 确认一次）**

- 桌面 JS：`react@19.2.8` `vite@8.2.2` `@vitejs/plugin-react@6.x` `typescript@5.9.x` `@tauri-apps/api@2.11.1` `@tauri-apps/cli@2.11.4` `@tauri-apps/plugin-sql@2.4.1` `plugin-fs@2.5.2` `plugin-dialog@2.7.3` `plugin-http@2.6.0` `plugin-opener@2.5.x` `pdfjs-dist@6.3.289` `zustand@5.0.15` `zod@4.5.4` `nanoid@6` `react-router@7.x` `tailwindcss@4.x` `vitest@4.1.11`
- Rust：`tauri = "2.11"`, `tauri-plugin-sql = { version = "2.4", features = ["sqlite"] }`, `tauri-plugin-fs/dialog/http/opener`, `keyring = { version = "4", features = ["apple-native"] }`
- 服务端：`hono@4.13.5` `drizzle-orm@0.45.2` `drizzle-kit@0.31.10` `zod@4.5.4` `@hono/zod-validator@0.7.x`
- 若 Vite 8（Rolldown）与 `tauri dev` HMR 有问题，回退 `vite@7.x`。

---

## 二、packages/shared（两端契约，先写）

```
packages/shared/src/
├─ text.ts        countZh(text)：去空白后 Array.from().length（含标点，起点式字数）；normalizeChapterText：NFC、CRLF→LF、去尾部空白
├─ hash.ts        hashChapterContent = sha256hex(utf8(normalize(s)))；hashStoryline = sha256hex(canonicalJson)；用 crypto.subtle（Bun 与 WebView 都可用）
├─ storyline.ts   StorylineDoc（见下）+ StoryBible schema
├─ novel.ts       License、NovelSummary/Detail/Ref、VersionSummary、ChapterMeta/Content、User
├─ bundle.ts      NovelBundleV1、NovelOrigin（fork 后桌面本地记录的溯源信息）
├─ constants.ts   LIMITS：≤500 章/版本、≤5 万字/章、≤300 万字/版本、blob 批 ≤20 个或 ~3MB
└─ api/           common(ErrorCode、ApiError、Page<T>、cursor)、auth、novels、versions、blobs、browse、forks、social
```

**StorylineDoc（zod，`version: 1`）**
```ts
{ version: 1, premise, themes: string[],
  characters: [{ id, name, aliases[], role, description, arc, relationships: [{ targetId, kind, note }] }],
  settings:   [{ id, name, kind: 'world'|'location'|'faction'|'item'|'rule'|'other', description }],
  arcs:       [{ id, title, summary, startChapterNo, endChapterNo }],
  beats:      [{ id, arcId, title, summary, chapterNo, characterIds[], settingIds[], order }],
  chapters:   [{ chapterNo, title, goal, beatIds[], povCharacterId, targetChars, endHook }] }
```
**StoryBible**：`{ characters: {[id]: {state, location, knowledge, relationships[]}}, timeline: [{chapterNo, event}], facts[], openThreads[], arcSummaries: {[arcId]: string}, styleNotes }`

**NovelBundleV1**：`{ bundleVersion: 1, exportedAt, server: {baseUrl}, novel: {id,title,summary,tags,language,writingStatus,license,allowDerivatives,author:{id,displayName}}, version: {id,versionNumber,committedAt,storylineHash,chapterCount,charCount}, storyline: StorylineDoc, bible: StoryBible|null, chapters: [{index,title,hash,content}], lineage: {sourceNovelId,sourceVersionId,rootNovelId,depth}, fork: {id}|null }`

**NovelOrigin（桌面本地）**：`{ serverUrl, forkId, sourceNovelId, sourceVersionId, sourceVersionNumber, sourceTitle, sourceAuthorId, sourceAuthorDisplayName, sourceLicense, rootNovelId, forkedAt }`

---

## 三、桌面端 apps/desktop

### 3.1 目录
```
src/
├─ main.tsx                 启动：db.init → secrets → llmRegistry → jobRunner.start → render
├─ app/{App,router}.tsx, layout/AppShell.tsx
├─ db/db.ts                 Db 接口 {select<T>(sql,params), execute(sql,params)}；tauri 实现 + node:sqlite 测试实现
├─ db/mappers.ts, db/repos/{settings,providers,documents,highlights,conversations,novels,storyline,chapters,bible,jobs,syncAccount}Repo.ts
├─ llm/{types,sse,openaiCompatible,anthropic,registry,tokens,retry,json}.ts
├─ llm/prompts/{context,passageDiscuss,outline,chapterTable,writeChapter,summarizeAndBible,lengthAdjust,rewritePlan,rewriteChapter}.ts
├─ jobs/{types,machine,planner,runner,events}.ts, jobs/steps/{outline,chapterTable,writeChapter,adjustLength,summarize,rewriteChapter}Step.ts
├─ novel/{wordBudget,bible}.ts, novel/storyline/{model,snapshot,diff,affected}.ts
├─ pdf/{pdfjs,import,textIndex,anchor}.ts
├─ sync/{api,publish,fork,bundle}.ts
├─ secrets/keychain.ts
├─ stores/{ui,reader,jobs,studio,settings}Store.ts
├─ features/{library,reader,studio,settings,publicArea}/…
├─ components/{Button,Dialog,Input,Select,Tabs,Toast,Markdown}.tsx
└─ i18n/zh.ts               全部中文文案
src-tauri/
├─ Cargo.toml, tauri.conf.json, capabilities/default.json（sql、fs appdata、dialog、http https://**、opener）
├─ migrations/0001_init.sql
└─ src/{main.rs, lib.rs, secrets.rs}   secret_set/get/delete + read_env_api_key(仅匹配 ^[A-Z0-9_]+_API_KEY$)
```

### 3.2 SQLite 表（`migrations/0001_init.sql`，id 为 nanoid TEXT，时间戳 ms INTEGER，JSON 列 TEXT 经 zod 校验）

- **settings**(key, value JSON)；**llm_providers**(id, name, kind∈{openai_compatible,anthropic}, base_url, model, context_window, max_output_tokens, json_mode∈{none,json_object,json_schema,tool}, temperature, extra_headers, secret_ref, is_default, …)。首启若有 `DEEPSEEK_API_KEY` 则种一条 DeepSeek，`secret_ref='env:DEEPSEEK_API_KEY'`（运行时解析，不落盘）。
- **documents**(id, title, file_rel_path, file_sha256 UNIQUE, page_count, last_page, last_zoom, …)；**document_pages**(document_id, page_no, text) 归一化页文本，用于锚点/上下文/搜索。
- **highlights**(id, document_id, page_no, kind∈{highlight,note}, color, anchor JSON, note_text, …)。Anchor = `{exact, prefix, suffix, start, end, rects:[{x,y,w,h}] 归一化 0..1}`。
- **ai_conversations**(id, kind∈{pdf_discuss,novel_assist,scratch}, document_id, novel_id, chapter_id, provider_id, …)；**ai_messages**(id, conversation_id, seq, role, content, context JSON{selectedText,pageNo,anchor,before,after}, usage, model)。
- **novels**(id, title, premise, requirements JSON{genre,style,pov,tense,tone,audience,taboos[],mustHave[],language}, target_chars, status∈{draft,planning,generating,writing,complete}, origin JSON NovelOrigin|null, remote JSON{serverUrl,novelId,currentVersionId,chapterHashes[],storylineHash,draftVersionId,publishAttemptId}|null, …)。
- **storyline_characters / storyline_settings / storyline_arcs / storyline_beats**（可编辑的规范化源，字段对应 StorylineDoc）；**storyline_snapshots**(id, novel_id, json StorylineDoc, reason∈{generated,user_commit,pre_rewrite,import})。
- **chapters**(id, novel_id, chapter_no UNIQUE, title, goal, target_chars, pov_character_id, beat_ids, current_version_id, status∈{planned,generating,draft,final,stale}, stale_reasons)；**chapter_versions**(id, chapter_id, version_no, content, char_count, summary, source∈{generated,rewritten,topup,trim,user_edit,imported}, storyline_snapshot_id, job_step_id, model, usage)。
- **story_bible_snapshots**(id, novel_id, after_chapter_no（0=大纲初始）, chapter_version_id, json StoryBible)。查某章前的圣经 = 取 `after_chapter_no = n-1` 的最新一条。
- **generation_jobs**(id, novel_id, type∈{generate_novel,regenerate_chapter,rewrite}, status∈{queued,running,pausing,paused,cancelling,cancelled,failed,completed}, params, provider_id, progress JSON, error, interrupted)；**job_steps**(id, job_id, seq, kind, chapter_id, status∈{pending,running,done,failed,skipped}, attempts, input, output_ref, partial_text, error)。
- **sync_account**(id=1, server_url, user_id, display_name, token_secret_ref)。token 存 Keychain。

### 3.3 LLM 层
- `LLMProvider { id, model, caps:{contextWindow,maxOutputTokens,jsonMode}, stream(req): AsyncIterable<StreamEvent> }`，`StreamEvent = delta|usage|done`，`LLMError.kind ∈ auth|rate_limit|context_length|server|network|aborted|bad_request`。
- **openaiCompatible**：`POST {base}/chat/completions`，`stream:true, stream_options:{include_usage:true}`；忽略 `reasoning_content`；json_schema 模式发 `response_format:{type:'json_schema',…strict}`，json_object（DeepSeek）发 `{type:'json_object'}` 并在提示词里附 schema。预置：DeepSeek `https://api.deepseek.com` / `deepseek-chat` / 128k / json_object；Qwen dashscope compatible-mode；Kimi moonshot；OpenAI。
- **anthropic**：`POST {base}/v1/messages`，`x-api-key` + `anthropic-version: 2023-06-01`；system 消息提升到 `system`；结构化输出用单个 tool `emit_result` + `tool_choice:{type:'tool'}`，累积 `input_json_delta.partial_json`。
- **retry**：401/403 不重试；429 尊重 `Retry-After` 否则 2s·2^n 抖动最多 6 次；5xx/网络最多 4 次；400 且报文含 context/length → `context_length`，调用方缩上下文重试一次。每个 provider 一个全局 `RateGate`（最小间隔 + 429 冷却），避免阅读器聊天与生成任务互相打架。
- **json.ts** `requestJson(provider, {schema})`：`z.toJSONSchema` → 请求；`parseJsonLoose`（去代码围栏、取首尾括号、去尾逗号、字符串外全角引号/冒号归一）→ `safeParse`；失败则一次 temperature 0 的修复调用；再失败步骤置 failed 并保留原文。
- **context.ts** 预算 = `contextWindow - maxTokens - 1500`；`estimateTokens = cjk*0.7 + other/4`（Anthropic 用 cjk*1.0）。固定顺序、各有上限，溢出时从底部丢：① system+要求 ② 本章计划 + 前 2 后 1 章计划全文，其余仅标题（1.5k）③ 故事圣经，本章 beats 涉及的人物/设定优先（3k）④ 最近 6 章摘要全文，更早用 `arcSummaries`（2.5k）⑤ 上一章末尾 ~800 字（1k）⑥ logline/主题（500）。
- **提示词模板**均为纯函数 `(input) => {messages, maxTokens, schema?}`，中文，可快照测试。共享 `systemBase(requirements)`：题材/风格/视角/时态/受众/禁忌（"绝对禁止出现：…"）/"只输出正文，不要章节标题、序号、说明；段落间空行"。
  1. passageDiscuss：`【所选段落】(第 N 页)…【上下文】…【问题】…`，保留最近 12 条历史。
  2. outline → `OutlineDoc`（title, logline, themes, settings, characters, arcs 覆盖 1..N 章, beats）。
  3. chapterTable → `ChapterPlan[]`，硬约束"恰好 N 章；targetChars 之和 = 总字数；单章 min–max"；每批 ≤30 章，携带上一批末 3 条。
  4. writeChapter：目标 `target*1.08`，不少于 `0.9*target`；`maxTokens = min(caps.maxOutputTokens, ceil(target*1.6)+400)`；target > 4500 分两个场景半章写。
  5. summarizeAndBible → `{summary ≤300字, bibleDelta{characterUpdates,newCharacters,newFacts,timelineEvents,openThreads,closedThreads}, continuityWarnings}` → `applyBibleDelta` → 新圣经快照。
  6. lengthAdjust：expand / trim 两变体，返回全文。
  7. rewritePlan（可选 LLM 辅助）：把确定性算出的受影响章节 + 故事线 diff 转成每章的中文"本章需要改变：…"。
  8. rewriteChapter：writeChapter + `【旧版本正文】` + `【改写要求】`；`revise`（尽量保留可用段落）/ `rewrite`（完全重写）。

### 3.4 生成任务引擎
- **planner**：`generate_novel` = outline → chapter_table → ∀n: write_chapter(n) → adjust_length(n) → summarize(n)；`regenerate_chapter(n)` = 三步，后续章节标 `stale(upstream_regenerated)`，可选"同时重生成后续章节"；`rewrite(items)` = 按章序 rewrite_chapter → adjust_length → summarize。
- **machine.ts（纯函数）**：`queued→running→completed`；`running→pausing→paused→running`；`running|paused→cancelling→cancelled`；`running→failed→(retry)running`；启动时 `running|pausing→paused(interrupted=1)`，按设置自动恢复或显示"有中断的任务"横幅。
- **步骤幂等**：先写结果（chapter_versions 带 `job_step_id`）再标 done；重启后按 `(chapter_id, job_step_id)` 找到已有结果直接标 done。plugin-sql 是连接池，不依赖跨 `execute()` 的事务。
- **runner**：单例，默认 1 job × 1 step 并发；每 job 一个 `AbortController`；pause/cancel 先写 DB 状态再 abort；步骤捕获 `aborted` 把自己回到 `pending`（保留 partial_text 仅供展示）。流式 delta 每 150ms 批量进 `jobsStore.live`，每 3s 落 `partial_text`。事件：`job:updated / step:updated / step:delta / chapter:versionCreated / novel:bibleUpdated`，组件按 id 订阅。
- **字数控制（wordBudget.ts）**：章数 `N = clamp(round(target/3000), 3, 150)`；章节表目标归一化到总和 = target；单章 `< 0.88·target` 扩写（最多 2 次），`> 1.2·target` 精简（1 次），每次一条新版本可回退；每章完成后把 `remaining` 按比例重分配到未写章节（±30% 夹紧）。全书目标 ±5%。

### 3.5 故事线编辑 → 受影响章节 → 改写
- 规范化表是编辑源；`snapshot.ts` 序列化为 StorylineDoc 存快照。自动快照时机：规划完成（generated）、任何改写任务前（pre_rewrite）、用户点"保存故事线版本"（user_commit）。每个 `chapter_versions` 记录其生成时的快照 id。
- **diff.ts**：按 id 比较实体，字段级 `{added, removed, changed:[{id, fields}]}`，beats 额外标 `moved`。
- **affected.ts（确定性规则）**，输入 diff + 当前 doc + 各章人物/设定出现集合（来自圣经 timeline 与章节摘要）：
  - chapters[n] 的 goal/beats/pov 变 → n `rewrite`；title/endHook 变 → `revise`
  - beat 增/删/改/移动 → 所在章（移动则新旧两章）`rewrite`
  - 人物仅 name/aliases 变 → 出现的所有章 `name_replace`（确定性替换，不走 LLM）
  - 人物 description/arc/relationships 变 → 首次出现之后的章 `revise`；若为 POV 人物 → `rewrite`
  - 设定变 → 引用章 `revise`；弧 summary 变 → 区间内未覆盖章 `revise`；删除人物/设定 → 出现章 `rewrite`
  - **涟漪**：最早 `rewrite` 章之后所有未受影响章标 `stale:continuity`，对话框默认不勾选，可勾"级联改写后续章节"作为 `revise`
- 输出 `RewritePlan {snapshotBeforeId, items:[{chapterNo, mode, reasons[]}]}` → `RewritePlanDialog`（复选框、预计 token/费用、每章说明）→ 提交 `rewrite` job。改写第 n 章的圣经输入取新谱系的 `after_chapter_no = n-1` 最新快照。
- 二创同流程：fork 下来的 bundle 生成本地 novel（`origin` 已设，章节 `imported`，故事线行、圣经快照 `after_chapter_no = N`），直接进故事线编辑器。另支持从 .txt/.md 导入（`第X章` 正则分章）+ "从正文反推故事线"。

### 3.6 PDF 阅读器
- `pdfjs.ts`：`GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`；`getDocument({url: convertFileSrc(path)})`。导入：dialog 选文件 → sha256 去重 → 复制到 `appdata/pdfs/` → 写 documents → 后台抽取各页文本进 document_pages。
- 虚拟化页列表，每页 canvas + pdf.js `TextLayer` + 绝对定位的 `HighlightLayer`。
- **anchor.ts**：`mouseup` 后遍历 text-layer span 算 `start/end`，取 `exact` + 32 字符 `prefix/suffix`，`range.getClientRects()` 按页 div 归一化。重定位：位置匹配 → exact 搜索 + prefix/suffix 消歧 → 失败标"无法定位"列在笔记面板。
- `SelectionPopover`：高亮 / 添加笔记 / 问 AI / 复制。右侧面板：`AiDiscussPanel`（每文档多会话，流式，"带上下文"芯片）、`NotesPanel`（按页分组，点击跳转）、`SearchPanel`（查 document_pages）。

### 3.7 页面路由
`/library`（文档 / 小说两 tab）、`/reader/:documentId`、`/studio/new`（三步向导：要求与字数滑块 → 前提/框架 → 模型与费用确认 → 大纲预览可编辑 → 章节表编辑 → 开始）、`/studio/:novelId/(storyline|chapters|jobs)`（StorylineEditor、ChapterList+ChapterEditor+VersionHistory+ChapterActions、JobsPage；全局底部 `JobProgressBar`）、`/settings/(providers|general|account)`、`/public`、`/public/:remoteId`（在线阅读、派生二创按钮）、自己小说上的 `PublishDialog`（许可、允许二创、摘要、标签、与上次发布的差异）。

---

## 四、服务端 apps/server

### 4.1 目录
```
apps/server/
├─ drizzle.config.ts（dialect sqlite, casing snake_case）, drizzle/（迁移，提交进仓库）, .env.example, data/（gitignored）
├─ src/index.ts（migrate → createApp → Bun.serve → 草稿 GC 定时器）, app.ts（组合根，测试也用）, env.ts
├─ src/db/{client,schema,migrate,seed,search}.ts      search.ts 是唯一允许方言 SQL 的地方
├─ src/lib/{errors,ids(UUIDv7),tokens,cursor,moderation,time}.ts
├─ src/middleware/{auth,rate-limit,client-id,error-handler,request-id}.ts
├─ src/modules/{auth,novels,versions,blobs,browse,forks,social,admin}/{routes,service}.ts（forks 另有 lineage.ts、bundle.ts）
├─ src/web/{layout,pages,routes}.tsx                  Hono JSX 服务端渲染，零客户端 JS
└─ test/{helpers,auth,publish,browse,fork,social,web,contract}.test.ts
```
Drizzle 列只用 `text / integer / integer{boolean} / integer{timestamp_ms} / text{json}`，全部查询走 query builder，不用递归 CTE。切 PG 时复制成 `schema.pg.ts` 改导入与 5 种列类型，`drizzle-orm/bun-sql` 客户端，约 1 小时。

### 4.2 表
- **users**(id, email UNIQUE 小写, passwordHash argon2id, displayName, bio, role∈{user,admin})；**sessions**(id, userId, tokenHash sha256, clientLabel, expiresAt 30 天滑动)。
- **novels**(id, authorId, title, summary, tags json, language, writingStatus, license∈{all-rights-reserved,cc-by,cc-by-sa,cc-by-nc,cc-by-nc-sa,cc0}, allowDerivatives, visibility∈{unpublished,public,unlisted}, moderationStatus∈{ok,hidden,removed}, currentVersionId, sourceNovelId, sourceVersionId, rootNovelId, depth, forkId, chapterCount, charCount, viewCount, likeCount, forkCount, publishedAt, lastPublishedAt)。谱系反规范化到本表：祖先沿 `sourceNovelId` 循环查（≤64 跳），后代 `WHERE root_novel_id = ?` 内存建树（≤500 节点）。
- **novel_versions**(id, novelId, versionNumber, status∈{draft,committed,aborted}, baseVersionId, idempotencyKey UNIQUE(novelId,key), storyline json, storylineHash, **bible json|null**, changeNote, chapterCount, charCount, committedAt)。提交后不可变。
- **blobs**(hash PK sha256, content, charCount, byteSize, firstUploaderId)：内容寻址，跨版本、跨 fork 自动去重；**version_chapters**(versionId, index, title, blobHash, charCount) PK(versionId,index)。
- **forks**(id, userId, sourceNovelId, sourceVersionId, derivativeNovelId|null)；**likes**(userId,novelId)；**view_events**(novelId, viewerKey, day) 每日去重；**reports**(id, novelId, reporterId, reason, detail, status)。
- MVP 不做库内 gzip（30 万字 ≈ 900KB），传输用 Hono `compress()`。

### 4.3 REST 契约（`/api/v1`，JSON，`Authorization: Bearer tw_<43 chars>`，匿名请求带 `X-Client-Id`）
错误统一 `{error:{code,message,details}}`；列表用 keyset 游标 `Page<T> = {items, nextCursor}`；`:vid` 可为 `current`。

- **auth**：`POST /auth/register|login` → `{user, token, expiresAt}`；`POST /auth/logout`；`DELETE /auth/sessions`；`GET|PATCH /auth/me`
- **发布（作者）**：`POST /novels`（可带 `source:{forkId}` 创建二创）；`PATCH|DELETE /novels/:id`；`GET /me/novels`；`POST /novels/:id/versions`（头 `Idempotency-Key`，体 = storyline + bible + 章节清单 `[{index,title,hash,charCount}]`）→ `{version, missingHashes}`；`POST /blobs`（≤20 个/≤4MB，服务端重算 hash，不匹配拒绝）；`POST /novels/:id/versions/:vid/commit`（事务：校验 blob 齐全 → 审核钩子 → 分配版本号 → 写 version_chapters → 更新 novel 快照字段与 visibility）；`GET|DELETE /novels/:id/versions/:vid`
- **浏览（公开）**：`GET /novels?sort=latest|popular|likes|forks&q&tag&license&writingStatus&allowDerivatives&originalsOnly&cursor&limit`；`GET /novels/:id`；`GET /novels/:id/versions`；`GET …/:vid/storyline`；`GET …/:vid/chapters?from&limit`；`GET …/:vid/chapters/:index`
- **fork / 谱系**：`POST /novels/:id/forks`（需登录；`allowDerivatives=false` → 403）；`GET …/:vid/bundle?forkId=` → NovelBundleV1（>200 万字返回 413 让客户端分页拉）；`GET /me/forks`；`GET /novels/:id/lineage` → `{root, ancestors[], self, descendants: tree}`，已下架节点占位"（已下架）"
- **社交/管理**：`PUT|DELETE /novels/:id/like`；`GET /me/likes`；`POST /novels/:id/view`；`POST /novels/:id/reports`；`GET /admin/reports`；`PATCH /admin/novels/:id/moderation`；`GET /health`
- 许可规则：fork 时检查权限，fork 记录即授权证明（源后来关闭二创不影响已 fork）；`cc-by-sa / cc-by-nc-sa` 的二创必须同许可；`all-rights-reserved` 强制 `allowDerivatives=false`。一个 fork 记录只能发布一本二创。

### 4.4 发布与 fork 协议（桌面 `sync/publish.ts`、`sync/fork.ts`）
1. 首次：`POST /novels` → 存 `remote.novelId`。
2. 算全部章节 hash + storylineHash，生成 `publishAttemptId`，`POST versions`（全清单，很小）→ 拿 `missingHashes`，存 `remote.draftVersionId`。
3. 按 ≤20 个/~3MB 打包上传 blobs，3 路并发，5xx/网络退避重试。
4. `commit`；409 `BLOBS_MISSING` 则回到 3。成功后存 `currentVersionId / chapterHashes / storylineHash`。
5. 更新 = 同流程，服务端只会要变更章节的 blob；崩溃恢复：`GET versions/:vid` 拿 status 与 missingHashes 续传；丢了 vid 用同一 `Idempotency-Key` 重 POST 得到同一草稿。
6. fork：`POST forks` → `GET bundle` → zod 校验 + 本地逐章重算 hash 核对 → 建本地 novel（origin、baseChapterHashes、baseStorylineHash，供"已改写 N 章"显示与二创发布只传变更 blob）。

### 4.5 安全
`Bun.password` argon2id；token 只存 sha256；内存滑动窗口限流（login 10/min/IP，register 5/h/IP，blobs 60/min/user，读 300/min/IP）；`bodyLimit` 默认 256KB、versions 1.5MB、blobs 4MB；每个 zod 字符串/数组带 `.max()`；CORS 允许 `tauri://localhost`、`http://tauri.localhost`、`http://localhost:1420`，头含 `Authorization, Content-Type, Idempotency-Key, X-Client-Id`；鉴权在 service 层校验 `authorId === user.id || admin`；`ContentModerator` 接口 + `noopModerator`，commit 时调用，失败置 `hidden` 显示"审核中"；SQLite `WAL, foreign_keys=ON, busy_timeout=5000`；错误响应不泄漏堆栈，带 `X-Request-Id`。

### 4.6 网页阅读页（MVP 含，~200 行）
`GET /`（最新 20 本）、`GET /n/:id`（详情、章节表、"改编自 X 第 v3 版"）、`GET /n/:id/c/:index`（正文 + 上下章 + 服务端计浏览）。`secureHeaders` + 严格 CSP，仅此三个路由。

---

## 五、实施阶段（每阶段结束可运行）

| # | 内容 | 可验证结果 |
|---|---|---|
| **0** | 单仓脚手架；`packages/shared`（text/hash/storyline/bundle/constants + 单测）；desktop：Tauri 工程、`0001_init.sql`、Db 接口、keychain 命令、LLM 层全部、设置页 Providers、临时对话页 | `bun run --filter desktop tauri dev` 打开应用，配置 DeepSeek，流式聊天成功 |
| **1** | PDF：导入、渲染、文本层、锚点、高亮/笔记、选段问 AI、笔记面板、搜索 | 导入 200 页 PDF，选段 → 问 AI；高亮重启后仍在 |
| **2** | 小说工坊核心：向导、大纲、章节表、任务引擎、写章、字数控制、圣经、章节编辑与版本 | 生成 1 万字小说；中途暂停、退出应用再启动能续写；总字数 ±5% |
| **3** | 故事线编辑器、diff/affected、RewritePlanDialog、改写任务、过期标记、txt 导入 + 反推故事线 | 改主角弧 → 列出受影响章节及原因 → 改写完成 |
| **4** | 服务端全部（P0 骨架 → 认证 → 发布管线 → 浏览 → fork/谱系 → 社交/管理 → 网页阅读）+ contract 测试 | `bun run dev` 起服务；`bun test` 全绿，含 100 章发布/续传/二创谱系用例 |
| **5** | 桌面公共区：账号面板、PublishDialog、浏览/在线阅读、fork 导入、origin 徽标 | 发布 → 另一账号 fork → 改故事线 → 改写 → 发布二创 → 谱系可见 |
| **6** | 打磨：导出 TXT/Markdown、任务运行时关窗最小化到 Dock、用量/费用统计、`thewater://` 深链、`bun tauri build` 打包 | 可安装的 .app |

阶段 0–3 不依赖服务端；阶段 4 可与 3 并行。

---

## 六、验证

**运行**
```bash
bun install
bun run --filter desktop tauri dev      # 首次编译 Rust 需几分钟；启动前 export DEEPSEEK_API_KEY
bun run --filter server dev             # bun --watch src/index.ts
bun run typecheck && bun run test       # tsc -b；vitest(desktop, shared) + bun test(server)
```

**单元测试（关键纯模块）**
- `llm/sse`：分块切在多字节字符/行中间、CRLF、`event:`+`data:`、`[DONE]`
- `llm/openaiCompatible`、`anthropic`：假 fetch 脚本化 SSE → StreamEvent 序列；429 Retry-After、400 上下文超长、401 映射
- `llm/json`：围栏、尾逗号、全角标点、截断 JSON → 触发修复
- `llm/prompts/*` 快照；`context`：预算丢弃顺序与上限，绝不超预算
- `novel/wordBudget`：countZh、章数夹紧、重分配夹紧
- `novel/storyline/diff`、`affected`：仅改名 → name_replace；POV 变 → rewrite；beat 移动 → 两章；涟漪；删人物
- `jobs/machine` 全转移表；`jobs/runner`（假 provider + node:sqlite）：版本已写但步骤未标 done 时崩溃恢复不重复；pause 中止流并回 pending；重试计数
- `pdf/anchor`：合成 span 建锚、归一化变化后重定位、exact 出现两次用 prefix/suffix 消歧
- `shared/hash`：固定向量（含 CRLF、NFC）；`shared/bundle` 往返校验
- server：auth（重复邮箱、过期会话、滑动续期）、publish（100 章端到端、幂等重 POST、断点续传、hash 不匹配、缺 blob 409、改 3 章只传 3 个）、browse（可见性过滤、游标稳定、每日去重浏览）、fork（bundle → 二创发布复用 80 个 blob → 双向谱系、SA 继承、ARR 禁止）、contract（每个端点响应过 shared zod）

**手工 E2E 清单**
1. 设置：DeepSeek（env）、Anthropic（手填 key，Keychain Access 里可见）、测试连接流式；切默认写作模型。
2. 阅读器：滚动/缩放性能；跨行选择；高亮重启保留；缩放后锚点仍对；问 AI + 追问。
3. 1 万字小说全流程；暂停/退出/续写；重生成第 2 章后第 3 章起标"过期"。
4. 故事线：改名只出名称替换；改弧列出原因；改写后圣经视图更新。
5. 10 万字跑 30+ 章：日志可见 429 退避、字数漂移修正、同时在阅读器聊天不卡。
6. Anthropic 跑大纲（tool 模式 JSON）与写章。
7. 云端：登录、发布、浏览、在线读、fork → 本地带 origin → 改写 → 发布二创 → 网页 `/n/:id` 显示"改编自"。

---

## 七、社区（第五期，2026-09-02 实现）

用户确认的四项决策：激励用虚拟积分 + 等级徽章 + 榜单（二创被阅读时原作者分成，不涉及真实货币）；分享包含动态流、留言、站外链接/卡片、作者主页；账号为资料页 + 唯一 @用户名 + 生成式头像（不做邮箱验证与头像上传）；屏蔽为全面屏蔽。

### 7.1 关键设计

- **原创/二创是小说的属性，不是事件的属性**：动态 `kind` 只有 `novel_published | version_published | novel_completed`，二创通过 `novel.isDerivative` 与 `source` 体现，否则二创的后续版本还要再加一种 kind。
- **规则即数据**：`packages/shared/src/incentive.ts` 定义 `POINT_RULES / LEVELS / BADGES`，服务端只有 `modules/incentive/service.ts` 的 `award()` 一个写入口。幂等靠 `point_ledger.dedupeKey`（NOT NULL + 唯一索引），日上限按 UTC 日计数。**撤销一律不扣分**（取消喜欢、取关、删留言），规则简单且不会被刷成负分。
- **屏蔽 = 双向不可见 + 单向禁互动**：列表用 `notInArray(authorCol, 子查询)` 过滤（drizzle 原生支持，不引入方言 SQL）；直链 `GET /novels/:id` 仍可读，因为网页版本就公开。
- **留言两级**：`parentId` 恒指向顶层，`replyToId` 指向被回复的具体一条；有回复的顶层被删后保留墓碑。
- **分享链接指向服务端网页**（`/n/:id`、`/u/:handle`），绝不使用桌面 hash 路由。

### 7.2 新增表（`apps/server/src/db/schema.ts`，迁移 `drizzle/0001_complex_speed.sql`）

- `users` 增 `handle`（唯一）、`followerCount`、`followingCount`、`points`；`novels` 增 `commentCount`；`reports` 增 `commentId`。
- `follows(followerId, followeeId)`、`blocks(blockerId, blockedId)`、`activities(id, actorId, kind, novelId, versionId, dedupeKey)`、`comments(id, novelId, authorId, parentId, replyToId, body, status, replyCount)`、`point_ledger(id, userId, kind, points, refType, refId, dedupeKey, meta)`、`user_badges(userId, badge)`。
- 迁移里 `handle` 先加 `DEFAULT ''`，再按 `'u_' || lower(substr(replace(id,'-',''), 21, 12))` 回填，最后才建唯一索引——UUIDv7 前 8 位是毫秒时间戳，同毫秒注册会撞，必须取尾部随机位。**这份 SQL 是在 `db:generate` 之后手工改的，快照未动，重新 generate 时不要覆盖掉回填语句。**

### 7.3 积分规则

| kind | 分值 | 受益人 | 上限 / 备注 |
|---|---|---|---|
| novel_published | 原创 50 / 二创 30 | 作者 | 首版一次 |
| version_published | 10 | 作者 | 每本每 UTC 日一次 |
| novel_completed | 20 | 作者 | 一次 |
| like_received | 2 | 作者 | 每人每本一次；自赞 0 |
| fork_received | 10 | 作者 | 每人每本一次；自 fork 0 |
| view_received | 原创 10 / 二创 7 | 作者 | 每本每日 ≤30 次计分；匿名计分；作者自读 0 |
| view_shared | 3 | 直接来源作者 | 只上溯一层 |
| comment_posted | 1 | 留言者 | 每人每日 ≤10 |
| comment_received | 1 | 作者 | 每本每日 ≤20；自评 0 |
| follower_gained | 2 | 被关注者 | 每人一次 |
| adjustment | 负/正 | — | 管理员下架时冲正 |

等级 7 级（初涉 0 / 执笔 100 / 成篇 300 / 结集 800 / 名家 2000 / 宗师 5000 / 传世 12000）；徽章 10 枚。榜单为滚动 7 天 / 30 天 / 总榜，路由闭包内缓存 120 秒。

### 7.4 新增端点

`GET /users/:id`、`GET /users/by-handle/:handle`、`GET /users/:id/novels?kind=`、`PUT|DELETE /users/:id/follow`、`PUT|DELETE /users/:id/block`、`GET /me/following|followers|blocks`、`GET /feed?scope=following|all&actorId=`、`GET|POST /novels/:id/comments`、`GET /novels/:id/comments/:cid/replies`、`DELETE /novels/:id/comments/:cid`、`POST /novels/:id/comments/:cid/reports`、`PATCH /admin/novels/:id/comments/:cid`、`GET /me/points`、`GET /leaderboard?board=&period=`。`PATCH /auth/me` 与注册新增 `handle`；`PATCH /admin/novels/:id/moderation` 新增 `reversePoints`。错误码新增 `BLOCKED`(403)、`HANDLE_TAKEN`(409)。

网页版新增 `GET /u/:handle`（作者主页）、`GET /u/:handle/avatar.svg`、`GET /n/:id/cover.svg`，并在作品页与作者页输出 OG 标签（`PUBLIC_BASE_URL` 为空时省略 `og:url` 与 `og:image`）。

### 7.5 桌面端

- 路由：`/public/feed`、`/public/ranking`、`/public/u/:handle`（均为平级路由）；设置页新增 `/settings/community`。「公共书房」仍是侧栏唯一入口，页面顶部用 pill 标签切 书房 / 动态 / 榜单。
- 新增 `src/community/`（纯逻辑，可单测）：`avatar`（`hashHue` 从 `components/ui.tsx` 提出来供头像与书封共用）、`level`、`feedText`、`shareCard`、`textWrap`、`shareImage`（Canvas 画 1200×630 分享图）、`errors`、`handle`。
- 新增组件：`Avatar`、`UserChip`、`FollowButton`、`LevelBadge`、`ShareDialog`、`PublicTabs`、`useLoginGate`、`CommentSection/Composer/Item`、`ActivityCard`、`FeedList`、作者主页、榜单页、`ProfileEditDialog`、`PointsCard`、`RelationsPanel`。
- 本地库迁移 `0003_community.sql` 只加 `sync_account.handle`；剪贴板走新加的 `@tauri-apps/plugin-clipboard-manager`（失败时回退 `navigator.clipboard`）。

### 7.6 已知限制

- `og:image` 是 SVG，微信/Twitter 的抓取器不渲染它；站内 `<img>` 与桌面端分享图不受影响。要外站卡片图需再写一个 PNG 编码器输出 `/n/:id/cover.png`。
- 改 `handle` 会让旧 `/u/:handle` 链接失效；桌面端作者页先按 handle 查、404 再按 id 查作为兜底。
- 匿名浏览计分可通过轮换 `X-Client-Id` 刷到每本每日 30 次上限；上限在 `POINT_RULES` 里可调。
- 留言没有接入 `ContentModerator`（它的输入形状是整本小说），先靠举报 + 管理员隐藏。
