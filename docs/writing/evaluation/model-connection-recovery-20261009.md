# 模型连接恢复验收（2026-10-09）

原因：8787 后端恢复后，向导仍显示 settingsStore 中启动时缓存的模型能力连接错误。真实服务日志中的 `/api/v1/writing/capabilities` 已返回 200；截图中的错误不能代表当前连接状态。

修复：ModelPurposePicker 进入时重新检查供应商，并在失败时显示原地重试按钮。创建按钮提交前再次检查实际可用模型。settingsStore 仅接纳最新连接检查结果，旧失败响应不能覆盖较新的成功响应。增加本机创建草稿保存及重启恢复，保留框架、要求、参数、模型选择、篇幅、步骤和作者字段保护状态；成功创建作品后清理创建草稿。

验证：完整桌面回归 939 passed、5 skipped，正式构建内类型检查和 git diff --check 通过。新增连接检查乱序保护测试、真实 SQLite 草稿往返及不兼容格式拒绝测试。首次草稿测试失败为 ZodError: Invalid input: expected string, received undefined（providerIds 未单独指定的用途）；使用部分模型配置 schema 修复后重跑全部测试通过。失败与通过日志均保留在 `/Users/caoshuo/.codex/validation/the-water-wizard-recovery-20261009/`。

正式 app / DMG 已构建安装，codesign 与 DMG 校验通过（CRC32 29492835）。安装二进制与构建二进制 SHA256 一致：1d5c1685e6a97cb6b02447b5824efc01f8ab0efb062c242b4fa2b5a2ba6b383a。

原生实测：更新前从界面逐字保存并再次核对作者当前未提交草稿，恢复到新向导；当前确认页显示原书名、创作参数、30 万字 / 100 章，模型选择器正常显示，旧连接错误消失，创建大纲按钮可用。没有提交生成任务，没有修改正文或已有任务。该次迁移将当前七项参数及题材包标为保护字段，避免更新后被 AI 覆盖。本轮没有重新评测文学质量；未配置价格时费用仍无法折算金额。
