# 人工反馈后的修订与复测 · 2026-10-10

**文学效果未通过本轮验收。** 用户更愿意读 X，但首次阅读的动机与前因不足，两篇的道具与签字权因果受到质疑，X 的结尾意象分量未被建立。原话见 [真实人工反馈](reader-human-feedback-20261010.json)。一位读者的判断不等于总体质量或模型准确率；X/Y 是不同讲法，不是修订前后比较。

两份原始评阅材料保持冻结、hash 不变。实际通过 `saveHumanLiteraryReview` 将对应意见写入两个隔离 TEST 库，两个包的状态均为 `human_reviewed`；保存后包内容不变，外键检查为空。原生验收 JSON 保留当时尚未收集反馈的快照，不重写历史。

## 本次代码调整

- 写作、规划与审稿共用的情节规则区分持有道具、表达意愿、获得权限和实际结果，检查普通替代物；结尾意象需与已经呈现的争取、代价或意义变化相称，不靠重复制造胜利感，不补造制度或经历。
- 样稿先仅凭正文独立审查生效机制，再核对固定事实。两项都支持才可新建待审分支；因果证据须为对应样稿的唯一连续原文。历史仅核对事实的记录不能直接授权新分支，可对原文复审，复审不改样稿。
- 首次阅读区分目标明确与个人利害已传达。新增 `inferenceChecks`，分别保存关键推断、支持状态、结论引文与推断依据；实际兴趣仍在 `confusions` 中独立记录。新结果必须具备该字段，旧结果仍可阅读但不复用为新审查。界面显示证据，保存时核对来源版本与原文。

收益是材料里成立的结果不能自动替正文补齐机制，兴趣也不能掩盖未经建立的推断。代价是额外模型调用、报告长度和作者核对成本；机制审查仍可能误判，不要求消灭一切未来越权，不因平静、留白或个人审美损失单独阻断。

## 真实调用及失败记录

| 记录 | 实际结果与边界 |
| --- | --- |
| [初次反馈复审](reader-human-regression-real-20261010.json) | 两稿机制均 `missing_basis`，但首次阅读未报结尾疑问。初版测试未覆盖这个漏报，程序通过不能掩盖它。 |
| [推断提示复审](reader-human-regression-real-20261010-inference.json) | 测试失败：`AssertionError: expected 'supported' not to be 'supported'`。重要性解释承认具体后果缺失，confidence 却仍是 supported；两稿机制也被判 supported，与人工质疑不一致。 |
| [新样稿生成](story-narration-real-20261010-mechanism.json) | 三份新稿都未同时通过固定事实与机制检查，没有送入分支。测试失败：`AssertionError: At least one narration candidate must preserve fixed facts before staging a branch: expected undefined to be defined`。不称为合格样稿生成成功。 |
| [只读正文机制复审](reader-human-regression-real-20261010-blind-mechanism.json) | 两稿机制缺口被检出，重要性 tentative；结尾仍被当作吸引继续读。测试失败：`AssertionError: The closing knowledge inference needs an explicit grounding concern: expected false to be true`。 |
| [最终关键推断复审](reader-human-regression-real-20261010-inference-checks.json) | 冻结原文、未提供人工答案；4 次 HTTP 200（保留全部请求与响应，不将重试算为独立样本）。重要性 tentative；结尾可能使人推断师傅不是目击者的认识被记为 missing_basis；两稿机制均 missing_basis。测试及逐字证据校验通过。 |

各次记录保留各自源码 hash 与请求提示，提示版本不同，不是单因素受控对照，不能把结果变化单独归因于某条规则。新样稿生成记录来自中间版本；最终版本只对冻结文本做了诊断复测，未重新验证生成合格新稿。

最终回答仍把部分疑问记为 inviting，与人工“不吸引、妨碍理解”不同；损失判断也未完整反映用户对结尾分量的批评，甚至批评了用户喜欢的限知判断。最终测试只验证这些已知材料的诊断与来源契约，不能证明新稿更好、提示能泛化，或模型已经可靠地识别阅读兴趣。测试断言从个人兴趣分类改为独立推断证据，保留两项职能的区别，未把历史失败重标为成功。

## 自动验证与执行边界

最终桌面全量 **1,104 通过、13 默认跳过**；新增推断后的针对性测试 46 通过，TypeScript 检查与 Vite 构建通过，`git diff --check` 通过。新增推断引文与依据检查包含缺失依据、未提供章节和错误来源的回归；机制门禁包含不成立、矛盾、历史未审查报告及原稿复审不变的回归。

执行时误用了项目未安装的 pnpm：`zsh:37: command not found: pnpm`；仓库实际使用 Bun，随后按项目脚本执行。新增必需字段后的旧 TEST 模拟响应导致 `只读正文的首次阅读: 模型输出的 JSON 3 次校验失败：inferenceChecks: Invalid input: expected array, received undefined`，修正模拟响应后重跑通过；模拟数据不是模型真实结果。临时人工反馈导入测试已删除。

本次只交付源码和构建验证，没有重新打包或逐项观察新增界面控件；此前原生记录仅适用于其当时源码。没有修改冻结样稿、正式作品库或正式正文，也没有宣称合格新稿已生成。下一轮文学验收仍需新的实际正文与人工评阅，不能拿同一失败样本的反复诊断代替。
