import type { ChatMessage, PromptSpec } from '@/llm/types';
import { joinSections, section, sys, takeLast, user } from './base';
import { UNTRUSTED_GUARD_RULE } from './untrusted';

export const PASSAGE_HISTORY_LIMIT = 12;

export interface PassageDiscussInput {
  selectedText: string;
  pageNo: number | null;
  before: string;
  after: string;
  question: string;
  history: ChatMessage[];
  docTitle: string;
}

export function passageDiscussPrompt(input: PassageDiscussInput): PromptSpec<string> {
  const title = input.docTitle.trim();
  const system = [
    `你是一位严谨的阅读助手，正在帮助用户理解${title ? `文档《${title}》` : '一份文档'}。`,
    '回答必须以所选段落及其上下文为依据；引用原文时用「」标出原句；遇到原文没有给出、你也不确定的信息，要明确说明"原文未提及"或"我不确定"，不要编造。',
    '使用简体中文回答，语气平实、条理清晰；除非用户要求，不要长篇复述原文。',
    // 选段与上下文来自用户导入的文档，调用方会用 `wrapUntrusted` 包起来；这里把约定讲清楚。
    UNTRUSTED_GUARD_RULE,
  ].join('\n');

  const history = takeLast(input.history, PASSAGE_HISTORY_LIMIT).filter((m) => m.role === 'user' || m.role === 'assistant');

  const pageTag = input.pageNo !== null && input.pageNo !== undefined ? `（第 ${input.pageNo} 页）` : '';
  const question = input.question.trim() || '请解释这段话的含义，并指出其中值得注意的地方。';
  const text = joinSections([
    input.selectedText.trim() ? `【所选段落】${pageTag}\n${input.selectedText.trim()}` : '',
    section('上下文（前）', input.before),
    section('上下文（后）', input.after),
    section('问题', question),
  ]);

  return {
    messages: [sys(system), ...history, user(text)],
    maxTokens: 2048,
    temperature: 0.4,
    label: '讨论段落',
  };
}
