/** 「随手问 AI」与阅读器 AI 讨论面板共用的会话文案。 */
import type { Locale } from '../shape';

export const chat: Locale['chat'] = {
  placeholder: 'Ask anything…',
  placeholderHint: 'Type a question. Enter to send, Shift+Enter for a new line',
  send: 'Send', stop: 'Stop', thinking: 'Thinking…', noProvider: 'Model service unavailable. Sign in or check model settings.',
  newConversation: 'New chat', conversationList: 'Chats', deleteConversation: 'Delete this chat',
  noConversations: 'No chats yet — ask whatever comes to mind',
  emptyTitle: 'Ask whatever comes to mind',
  emptyDesc: 'Questions from your reading, or a spot where your writing is stuck — talk it through here.',
  sendHint: 'Enter to send · Shift + Enter for a new line',
  systemPrompt: 'You are a helpful assistant. Reply in English.',
  /** 阅读器面板专用 */
  passageEmptyTitle: 'Pick a passage and read it with AI',
  passageEmptyDesc: 'Or just ask a question below',
  passagePlaceholder: 'What would you like to ask? Leave it empty and AI will unpack this passage',
  dropPassage: 'Without this passage',
  defaultPassageQuestion: 'Please explain what this passage means.',
  messageList: 'Conversation',
  roleUser: 'You', roleAssistant: 'AI',
};
