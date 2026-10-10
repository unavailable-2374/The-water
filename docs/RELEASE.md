# 发布、签名与自动更新

这份文档说明 The Water 桌面版怎么打包、怎么签名、自动更新怎么走，以及
「v1 只发 macOS」这个决定具体收敛到了哪些地方。

相关文件：

```
.github/workflows/release.yml        打 v* 标签触发的发布流水线
apps/desktop/src-tauri/tauri.conf.json  打包目标、更新端点与签名公钥
apps/desktop/src-tauri/Cargo.toml    平台条件依赖（keyring 只在 macOS 上链接）
apps/desktop/src/platform/updater.ts 前端的「检查更新 / 安装 / 重启」
```

---

## 1. 一次性准备：生成更新签名密钥对

自动更新的更新包必须签名，客户端用公钥校验后才会安装。**没有这一步，
发现严重 bug 也推不出修复。**

```bash
cd apps/desktop
bun run tauri signer generate -w ~/.the-water/updater.key
```

它会产出两样东西：

| 产物 | 去处 |
|---|---|
| **私钥**（`~/.the-water/updater.key`） | 只进 GitHub 仓库 secret，**绝不进仓库、绝不进聊天记录** |
| **公钥**（命令输出的 `Public key:` 那一串） | 粘进 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` |

公钥是公开信息，放进仓库没问题；私钥丢了就再也签不出能被老客户端接受的更新，
请另外离线备份一份。

### 配到 GitHub

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 内容 | 必需 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件的**全部内容**（`cat ~/.the-water/updater.key`） | 是 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成私钥时设的口令；没设就留空 | 是（可为空） |
| `APPLE_CERTIFICATE` | Developer ID Application 证书导出的 `.p12`，base64 编码 | 否 |
| `APPLE_CERTIFICATE_PASSWORD` | 上面这个 `.p12` 的口令 | 否 |
| `APPLE_SIGNING_IDENTITY` | 形如 `Developer ID Application: 你的名字 (TEAMID)` | 否 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证（notarization）用的 Apple ID、**应用专用密码**、Team ID | 否 |

Apple 那一组不配也能发版，只是产出的是未签名包：用户第一次打开要右键
「打开」绕过 Gatekeeper。更新签名（上面第一组）和 Apple 代码签名是两回事，
**前者不可省**。

`.p12` 转 base64：

```bash
base64 -i cert.p12 | pbcopy
```

---

## 2. 更新端点

`apps/desktop/src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"],
    "pubkey": "<公钥>"
  }
}
```

`latest.json` 由发布流水线自动生成并作为 release 资产上传（`tauri-action`
的 `includeUpdaterJson`）。`releases/latest/download/...` 这个路径永远指向
**最新的已发布（非草稿、非预发布）release**，所以草稿状态下客户端是拿不到的 ——
这正是我们要的：产物先人工过一眼，再点 Publish。

> 仓库还没配 git remote 时，`endpoints` 里的 `<owner>/<repo>` 是占位值，
> 第一次发版前记得改成真实仓库地址。

---

## 3. 发一个版本

```bash
# 1. 改版本号（两个文件必须一致，流水线会校验）
#    apps/desktop/package.json          "version"
#    apps/desktop/src-tauri/tauri.conf.json  "version"

# 2. 提交并打标签
git commit -am "release: v0.2.0"
git tag v0.2.0
git push && git push --tags
```

`release.yml` 随即：

1. 校验标签、`package.json`、`tauri.conf.json` 三处版本号一致；
2. 校验 `pubkey` 非空、`TAURI_SIGNING_PRIVATE_KEY` 已配置（缺了就直接失败，
   而不是产出一个装了却更新不了的包）；
3. 跑一遍 `typecheck` + `test`；
4. `tauri build --target universal-apple-darwin`，产出
   `.dmg`、`.app.tar.gz`、`.app.tar.gz.sig`、`latest.json`；
5. 建一个**草稿** release 并把产物传上去。

最后一步是人工的：在 GitHub 上确认产物齐全、把 release notes 写好，
再点 **Publish release**。发布那一刻起，老版本才会检查到更新。

### 本地打包

本地构建默认会尝试生成更新产物（`bundle.createUpdaterArtifacts: true`），
没有私钥会失败。本地测试用 `.app` 与 `.dmg` 使用独立脚本关闭更新产物，
并让打包器以 ad-hoc 身份 `-` 签署完整应用包；仅保留链接器签名不能替代应用资源签名：

```bash
cd apps/desktop
bun run package:local
```

本地包不代表 Developer ID 签名或 Apple 公证通过。构建后分别运行 `codesign --verify --deep --strict`
检查应用包、`hdiutil verify` 检查 DMG，并实际启动验证；正式发布仍使用上述发布流水线和其签名配置。

---

## 4. 客户端的更新流程

* 检查与下载都在 Rust 侧（`tauri-plugin-updater` 用 reqwest 发起），
  **不经过 webview 的网络栈**，所以 CSP 的 `connect-src` 不需要为更新端点开口子
  —— 这跟 LLM 请求走 `plugin-http` 是同一个道理，见 `src/app/csp.ts` 的注释。
* 前端接口在 `src/platform/updater.ts`：
  `checkForUpdate()` → `installPendingUpdate(onProgress)` → `relaunchApp()`。
  三个函数都不抛异常式地失败：没打包、没配公钥、网络不通都会变成
  `{ state: 'unavailable', reason }`，界面直接把 `reason` 显示出来。
* macOS 装完更新**不会**自动重启，必须由界面提示用户重启（`relaunchApp()`）。

---

## 5. 多平台：v1 只发 macOS

### 为什么

改之前是一个会真出问题的组合：`bundle.targets = "all"` 会产出 Windows 与
Linux 安装包，但 `keyring` 只启用了 `apple-native` feature —— 非 macOS 构建
**没有任何密钥存储后端**，用户填了 API Key 却存不住，或者悄悄落到不安全的地方。

两条路：(a) 明确「v1 仅 macOS」并把打包配置收敛过去；(b) 补齐 Windows
credential store 与 Linux secret-service 后端。选 (a)，理由：

* 除了密钥存储，`closeToDock`（关窗到 Dock）本来就只有 macOS 有意义，
  Windows / Linux 上是另一套交互（最小化到托盘 / 任务栏），要一起补；
* CI 目前只有 macOS runner，跨平台构建等于同时要开三条产物线与三套签名流程；
* 没有 Windows / Linux 用户在等这个版本，先把 macOS 上的自动更新链路走通，
  收益更实在。

### 收敛到了哪里

| 位置 | 改动 |
|---|---|
| `tauri.conf.json` | `bundle.targets` 从 `"all"` 改成 `["app", "dmg"]`；加 `macOS.minimumSystemVersion` |
| `Cargo.toml` | `keyring` 移进 `[target.'cfg(target_os = "macos")'.dependencies]` |
| `src/secrets.rs` | 非 macOS 走显式报错分支，返回「当前平台还没有密钥存储后端」，不做明文兜底 |
| `release.yml` | 单 job，`--target universal-apple-darwin`（Apple Silicon + Intel 通用包） |

### 以后要补 (b) 的话

1. `Cargo.toml` 里给 Windows 加 `keyring = { features = ["windows-native"] }`、
   给 Linux 加 `["sync-secret-service"]`（或 `linux-native-sync-persistent`）；
2. `src/secrets.rs` 的 `#[cfg(not(target_os = "macos"))]` 分支换成真实实现；
3. `bundle.targets` 加回 `msi`/`nsis`/`deb`/`appimage`，并为每个平台配签名；
4. `release.yml` 改成 matrix（macos-latest / ubuntu-22.04 / windows-latest），
   `tauri-action` 会把各平台产物合并进同一个 `latest.json`；
5. 复核 `closeToDock` 在非 macOS 上的行为。

---

## 6. 桌面端的其它运行时能力

发布相关的几个插件一并记在这里，改动时别漏：

| 能力 | 插件 | 落点 |
|---|---|---|
| 自动更新 | `tauri-plugin-updater` + `tauri-plugin-process` | `lib.rs`、`platform/updater.ts` |
| 单实例保护 | `tauri-plugin-single-instance` | `lib.rs`，第二个实例唤起已有窗口后退出，避免两个进程写同一个 SQLite |
| 窗口状态记忆 | `tauri-plugin-window-state` | `lib.rs`，位置 / 尺寸 / 最大化 |
| 日志文件 | `tauri-plugin-log` | `lib.rs` 的 `log_plugin()`，写 `$APPLOG`，单文件 2 MB、保留 5 份 |
| 系统信息 | `tauri-plugin-os` | 诊断包里的平台 / 架构 / 系统版本 |

**系统托盘没有做。** macOS 上「后台跑任务时把窗口关掉」已经由 Dock 图标 +
`RunEvent::Reopen` 承担了（`lib.rs` 的 `focus_main_window`），再加一个菜单栏
图标是第二个重复入口，还要额外维护图标资源、菜单与文案。等到真有「常驻显示
后台生成进度」这类需求时再做，那时托盘才有它自己的价值。

---

## 7. 诊断包

「设置 → 通用 → 关于 → 导出诊断包」会打出一个 zip，用户可以直接附在反馈里。
实现在 `src/diagnostics/`，脱敏规则在 `redact.ts`，测试在
`test/diagnostics/redact.test.ts`（构造含密钥的配置，断言产出的 zip 里搜不到原文）。

包里有：`README.txt`、`summary.txt`（版本 / 系统 / 目录 / 规模）、
`settings.json`、`providers.json`、`errors.txt`、`logs/*`。

脱敏是**硬要求**：API Key、密码、会话 token 一律不出现。具体规则：

* 系统钥匙串从头到尾没有被读取过 —— 密钥根本不在采集范围内；
* 请求头只保留名字，值全部替换；
* Base URL / 代理地址去掉 `user:password@` 与 query 串；
* 键名含 key / token / secret / password / authorization 等词的，值整体替换；
* 文本里 `sk-*`、`ghp_*`、`AIza*`、`xox*-*`、JWT、`Bearer *` 一律替换；
* 兜底：32 位以上、同时含大小写与数字的长串按密钥处理
  （纯小写十六进制的 sha256 与 UUID 不误伤，它们是定位问题的线索）；
* `clientId` 只留头尾各 4 位。

整个过程不联网、不自动上报，只在用户点按钮时发生。
