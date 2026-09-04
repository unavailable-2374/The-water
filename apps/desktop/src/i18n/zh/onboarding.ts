/** 首启引导：三步接上一个模型。 */
export const onboarding = {
  title: '欢迎使用 The Water', subtitle: '三步接上一个模型，就能开始读书和写故事。',
  stepProvider: '选供应商', stepKey: '填 Key', stepTest: '测试连接', pickHint: '国内网络推荐 DeepSeek：便宜、上下文长，注册就能用。',
  getKey: '去申请密钥', keyLabel: 'API 密钥',
  keyHint: '只保存在系统钥匙串里，不会明文写进磁盘，也不会上传到任何地方。',
  keyFor: '在「{name}」的控制台创建一个密钥，复制粘贴到下面。',
  testHint: '会真的发一次很短的请求来验证，花费通常不到一分钱。',
  testRunning: '正在验证…', testOk: '连接成功，可以开始了。', testFail: '连接失败',
  testRun: '开始测试', testRetry: '再试一次',
  doneTitle: '接上了，接下来做点什么？',
  doneImport: '导入一本 PDF', doneImportDesc: '把手边的书拖进来，边读边问 AI。',
  doneNovel: '写第一本小说', doneNovelDesc: '给一句故事前提，AI 陪你把它写成书。',
  importHint: '点书架右上角的「导入 PDF」，挑一本开始读。',
  skip: '以后再说',
  skipConfirmTitle: '跳过配置？',
  skipConfirmDesc: '没有模型的话，问 AI、写小说这些功能都用不了。随时可以到「设置 → 模型供应商」补上。',

  /** 进度条与列表的无障碍名字。 */
  stepsLabel: '配置进度',
  stepOf: '第 {index} 步，共 {total} 步：{label}',
  providerListLabel: '可选的模型供应商',
  /** 供应商卡片副标题：模型名 + 上下文长度。 */
  presetMeta: '{model} · {context} 上下文',
  showKey: '显示 Key',
  openFailed: '打不开浏览器：{message}',
} as const;
