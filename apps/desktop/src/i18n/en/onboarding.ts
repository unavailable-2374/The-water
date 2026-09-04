/** 首启引导：三步接上一个模型。 */
import type { Locale } from '../shape';

export const onboarding: Locale['onboarding'] = {
  title: 'Welcome to The Water', subtitle: 'Connect a model in three steps and start reading and writing.',
  stepProvider: 'Pick a provider', stepKey: 'Add a key', stepTest: 'Test the connection', pickHint: 'DeepSeek is a good place to start: cheap, long context, usable right after you sign up.',
  getKey: 'Get a key', keyLabel: 'API key',
  keyHint: 'Stored in the system keychain only — never written to disk in plain text, never uploaded anywhere.',
  keyFor: 'Create a key in the “{name}” console, then paste it below.',
  testHint: 'We send one very short real request to check it. It usually costs less than a cent.',
  testRunning: 'Checking…', testOk: 'Connected. You are all set.', testFail: 'Connection failed',
  testRun: 'Run the test', testRetry: 'Try again',
  doneTitle: 'Connected. What next?',
  doneImport: 'Import a PDF', doneImportDesc: 'Drag in a book you have on hand and ask AI as you read.',
  doneNovel: 'Write your first story', doneNovelDesc: 'Give it one line of premise and AI will write the book with you.',
  importHint: 'Click “Import PDF” at the top right of your shelf and pick a book to start.',
  skip: 'Maybe later',
  skipConfirmTitle: 'Skip setup?',
  skipConfirmDesc: 'Without a model, asking AI and writing stories will not work. You can always add one later in Settings → Model providers.',

  /** 进度条与列表的无障碍名字。 */
  stepsLabel: 'Setup progress',
  stepOf: 'Step {index} of {total}: {label}',
  providerListLabel: 'Available model providers',
  /** 供应商卡片副标题：模型名 + 上下文长度。 */
  presetMeta: '{model} · {context} context',
  showKey: 'Show key',
  openFailed: 'Could not open the browser: {message}',
};
