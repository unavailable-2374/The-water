# 备份与恢复演练

服务端所有数据——用户、作品、版本、以及全部章节正文（`blobs.content`）——都在**一个 SQLite 文件**里，
路径由 `DATABASE_URL` 决定（默认 `./data/dev.sqlite`）。这个文件没了，平台就没了。
本文是这套备份 / 恢复的操作手册，也是恢复演练的脚本。

---

## 1. 备份策略

| 项 | 值 |
|---|---|
| 方式 | SQLite `VACUUM INTO`（在线一致性快照，服务不用停） |
| 频率 | 每天一次，建议 UTC 03:00 |
| 输出目录 | `BACKUP_DIR`，默认 `./data/backups` |
| 文件名 | `the-water-YYYYMMDD-HHMMSS.sqlite`（UTC，字典序即时间序） |
| 保留 | GFS 轮转：**7 个每日 + 4 个每周 + 12 个每月**（并集，去重后约 19–23 份） |
| 校验 | 每次备份完成后立即跑 `PRAGMA integrity_check`，不通过则不执行轮转清理 |

### 为什么用 `VACUUM INTO`

- 对源库是只读操作，**服务运行中执行也能拿到一致快照**，不需要停机、不加长写锁。
- 产出的是一个已整理、没有 WAL 尾巴的独立单文件，直接就能当恢复源，不用管 `-wal` / `-shm`。
- 对比 `cp`：直接拷贝一个 WAL 模式的库是**不安全**的，主库文件可能只有一个头，数据都还在 `-wal` 里。

### GFS 轮转怎么判定

把所有备份分别按「天 / ISO 周 / 月」分桶，每个桶只留桶内**最新**的一份；
再各自保留最近 7 / 4 / 12 个桶，三份保留集合取并集，其余删除。
最新一次备份必然落在最近的日桶里，因此**永远不会被删**。
目录里不符合命名规范的文件（比如手工放的 `NOTES.txt`）一律不碰。

### 执行

```bash
cd apps/server

bun run db:backup                                  # 用 env 的 DATABASE_URL / BACKUP_DIR
bun run db:backup --db ./data/dev.sqlite --dir /mnt/backups
bun run db:backup --no-prune                       # 只备份，不做保留策略清理
```

输出示例：

```
备份完成：./data/backups/the-water-20260904-030000.sqlite（12.40 MB，完整性校验通过）
按保留策略清理 1 个旧备份：the-water-20260828-030000.sqlite
当前保留 19 个备份于 ./data/backups
```

### 建议的 cron

每天 UTC 03:00 备份，日志留档：

```cron
# /etc/cron.d/the-water-backup
CRON_TZ=UTC
PATH=/usr/local/bin:/usr/bin:/bin

0 3 * * *  thewater  cd /srv/the-water/apps/server && DATABASE_URL=/srv/the-water/data/app.sqlite BACKUP_DIR=/srv/the-water/data/backups /usr/local/bin/bun run db:backup >> /var/log/the-water/backup.log 2>&1
```

systemd timer 版本（更好排障）：

```ini
# /etc/systemd/system/the-water-backup.service
[Service]
Type=oneshot
User=thewater
WorkingDirectory=/srv/the-water/apps/server
Environment=DATABASE_URL=/srv/the-water/data/app.sqlite
Environment=BACKUP_DIR=/srv/the-water/data/backups
ExecStart=/usr/local/bin/bun run db:backup
```

```ini
# /etc/systemd/system/the-water-backup.timer
[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

> **异地副本**：本机备份只防误删，不防机器损坏。请另外把 `BACKUP_DIR` 同步到对象存储 /
> 另一台机器（`rclone sync` / `restic` 均可），并对副本也做同样的保留策略。

---

## 2. 恢复

> **先停服务。** 恢复会替换数据库文件；服务还开着时替换，正在运行的进程仍持有旧文件句柄，
> 会写回旧数据、或产生难以排查的 I/O 错误。

```bash
systemctl stop the-water            # 1. 停服务

cd /srv/the-water/apps/server
ls -lt "$BACKUP_DIR"                # 2. 挑一个备份

# 3. 先恢复到旁路路径验证（推荐，不动线上库）
bun run db:restore "$BACKUP_DIR/the-water-20260904-030000.sqlite" --to ./data/verify.sqlite

# 4. 确认无误后覆盖线上库
bun run db:restore "$BACKUP_DIR/the-water-20260904-030000.sqlite" --force

systemctl start the-water           # 5. 起服务
```

脚本做的事，按顺序：

1. 校验备份文件：`PRAGMA integrity_check` 必须为 `ok`；必须含 `users` / `novels` /
   `novel_versions` / `blobs` / `version_chapters` 五张关键表（防止把空库或无关的 sqlite 文件当备份）；
   外键异常只告警不阻断（灾难恢复时有脏数据也得先恢复）。
2. 目标库已存在时**必须显式 `--force`**，否则直接报错退出。
3. 把现有库连同 `-wal` / `-shm` **整组**改名为 `<db>.pre-restore-<时间戳>` 留底，随时可回退。
4. 复制备份就位，再对恢复后的文件跑一次 `integrity_check`。
5. 任何一步失败都会回滚到原库，不会留下半截状态。

参数：

| 参数 | 说明 |
|---|---|
| `<备份文件>` | 位置参数，必填 |
| `--to <路径>` | 恢复目标，默认 `DATABASE_URL` |
| `--force` | 目标已存在时才需要；没有它绝不覆盖 |

---

## 3. 怎么验证恢复结果

恢复完成后**必须**跑完下面五步才算数：

```bash
# 1. 迁移已是最新（应输出"迁移完成"，且不报错）
DATABASE_URL=./data/verify.sqlite bun run db:migrate

# 2. 行数体检：和备份当天的量级对得上
sqlite3 ./data/verify.sqlite \
  "select 'users', count(*) from users
   union all select 'novels', count(*) from novels
   union all select 'versions', count(*) from novel_versions
   union all select 'blobs', count(*) from blobs
   union all select 'chapters', count(*) from version_chapters;"

# 3. 引用完整性：不能有章节指向不存在的 blob（结果必须是 0）
sqlite3 ./data/verify.sqlite \
  "select count(*) from version_chapters vc
   left join blobs b on b.hash = vc.blob_hash where b.hash is null;"

# 4. 起服务，健康检查
DATABASE_URL=./data/verify.sqlite PORT=8788 bun run start &
curl -s localhost:8788/health

# 5. 端到端抽查：列表能出作品，随便点一本能读到正文
curl -s 'localhost:8788/api/v1/novels?sort=latest&limit=3'
curl -s "localhost:8788/api/v1/novels/<某个 id>/versions/current/chapters/0"
```

第 3 步是重点：章节正文和目录是分开两张表存的，
只要它对得上，就说明作品正文没丢。

---

## 4. 恢复演练

**每季度至少一次**，在预发或本机做，不要在生产上练：

1. 取**最近一份**生产备份（顺便验证异地副本真的能取回来）。
2. `bun run db:restore <备份> --to ./data/drill.sqlite`。
3. 跑完上面第 3 节全部五步验证。
4. 记录：备份文件的时间戳、恢复耗时、行数、发现的问题。
5. 演练完删掉 `./data/drill.sqlite` 与 `.pre-restore-*` 残留。

演练要回答的两个数：

- **RPO（能丢多少数据）**：当前每日备份 = 最坏丢 24 小时。要更小就提高备份频率
  （例如每 6 小时一次，把日桶保留数相应调大）。
- **RTO（多久能恢复）**：一次演练实测的「取备份 → 恢复 → 验证 → 起服务」总时长。

---

## 5. 相关环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `./data/dev.sqlite` | 数据库文件路径，备份的源、恢复的默认目标 |
| `BACKUP_DIR` | `./data/backups` | 备份输出目录 |
| `STORAGE_QUOTA_BYTES` | `209715200`（200 MB） | 每用户 blob 存储配额，`0` 表示不限制 |

---

## 6. 顺带一提：库为什么不会无限膨胀

- 超过 24 小时未提交的草稿 / 已中止版本由 `gcDrafts()` 清理。
- 不再被任何已提交版本（`version_chapters`）、也不被任何未过期草稿（`novel_versions.manifest`）
  引用的孤儿 blob，由 `gcBlobs()` 回收；只回收创建超过 24 小时的，避免删掉刚上传还没提交的内容。
- 两者都挂在服务进程每小时一次的定时 GC 里。
- 每用户 `STORAGE_QUOTA_BYTES` 配额挡住存储耗尽攻击；用户可通过 `GET /me/storage` 查看占用。

`VACUUM INTO` 产出的备份是整理过的，所以**备份文件通常比线上库小**，这是正常的。
