# CI 说明

- `ci.yml` 在 push 到 main 与所有 PR 上运行。
- `check` 作业跑三个工作区的 `typecheck` 与 `test`，并回放一次数据库迁移，
  确保迁移脚本对空库可执行。
- `tauri` 作业在 macOS 上构建前端产物并对 Rust 侧做 `cargo check`。
- `release.yml` 在推送 `v*` 标签时触发：校验版本号与签名配置 → 跑测试 →
  构建 macOS universal 包并签名 → 生成更新清单 `latest.json` → 建**草稿** release。
  草稿要人工确认后手动 Publish，`releases/latest/download/latest.json` 才会指向它。
  需要的 secret 与一次性的密钥生成步骤见 [`docs/RELEASE.md`](../../docs/RELEASE.md)。

## main 分支保护（需在 GitHub 仓库设置中手动开启）

Settings → Branches → Add rule，分支名 `main`：

- Require a pull request before merging
- Require status checks to pass before merging，勾选 `类型检查与测试` 与 `桌面端构建（macOS）`
- Require branches to be up to date before merging
- 禁止直接 push 到 main
