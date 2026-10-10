/** 「随手问 AI」与阅读器 AI 讨论面板共用的会话文案。 */
export const chat = {
  placeholder: '想问什么…',
  placeholderHint: '输入问题，Enter 发送，Shift+Enter 换行',
  send: '发送', stop: '停止', thinking: '正在思考…', noProvider: '模型服务不可用，请登录云端账号或检查模型设置',
  newConversation: '新对话', conversationList: '对话列表', deleteConversation: '删除这个对话',
  noConversations: '还没有对话，想到什么就问一句',
  emptyTitle: '想到什么，随手问一句',
  emptyDesc: '读书时的疑问、写作时卡住的地方，都可以在这里聊。',
  sendHint: 'Enter 发送 · Shift + Enter 换行',
  systemPrompt: '你是一个乐于助人的中文助手。',
  /** 阅读器面板专用 */
  passageEmptyTitle: '选一段文字，和 AI 一起读',
  passageEmptyDesc: '也可以直接在下面提问',
  passagePlaceholder: '想问什么？留空就请 AI 讲讲这段话',
  dropPassage: '不带这段',
  defaultPassageQuestion: '请解释这段话的含义。',
  messageList: '对话记录',
  roleUser: '我说', roleAssistant: 'AI 说',
} as const;
