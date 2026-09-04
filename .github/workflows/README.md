# CI 说明

- `ci.yml` 在 push 到 main 与所有 PR 上运行。
- `check` 作业跑三个工作区的 `typecheck` 与 `test`，并回放一次数据库迁移，
  确保迁移脚本对空库可执行。
- `tauri` 作业在 macOS 上构建前端产物并对 Rust 侧做 `cargo check`。

## main 分支保护（需在 GitHub 仓库设置中手动开启）

Settings → Branches → Add rule，分支名 `main`：

- Require a pull request before merging
- Require status checks to pass before merging，勾选 `类型检查与测试` 与 `桌面端构建（macOS）`
- Require branches to be up to date before merging
- 禁止直接 push 到 main
