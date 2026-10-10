/** Opt-in REAL review calls against explicitly fictional TEST contradictions. Not literary quality scoring. */
import { it, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useTestDb } from '../helpers/testDb';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl, providerById } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { locateNarrativeIssues, narrativeReviewPrompt } from '@/llm/prompts/narrativeReview';
import { requestJson } from '@/llm/json';
import { anchorEvidence } from '@the-water/shared';
const cases = [
  {
    id: 'TEST-early-knowledge',
    category: 'knowledge',
    basis:
      '已确认：角色顾岚在第三章才首次接触密码含义。当前是第一章，顾岚为唯一视角，此前没有任何人告诉她密码。',
    text: '顾岚第一次走到档案馆门口。她还没见过任何档案，也没和任何人交谈。她准确地按下了只有第三章密信才会公布的密码，门应声打开。',
  },
  {
    id: 'TEST-broken-motivation',
    category: 'motivation',
    basis:
      '已确认的人物红线：顾岚绝不以无辜工人的生计换个人奖金；本章她完全知情且没有受威胁、误解或改变信念。',
    text: '顾岚知道伪造签字会使十位无辜工人失业。她没有受到任何威胁，也没有改变保护工人的信念。为了独占一百元奖金，她毫不犹豫地伪造了他们的签字。',
  },
  {
    id: 'TEST-time-conflict',
    category: 'timeline',
    basis: '已确认世界规则：档案馆到东闸步行至少四十分钟。该世界没有车辆、传送或其他交通方式。',
    text: '钟敲了九下，顾岚离开档案馆，独自步行去东闸。她沿着唯一的路一直走，没有使用任何交通工具。九点十分，她已经在东闸完成了登记。',
  },
  {
    id: 'TEST-false-payoff',
    category: 'thread',
    basis:
      '已确认伏笔 TEST-red-key：尚未被任何人找到的红钥匙只开地下二号门；其他钥匙均不能开。当前本章红钥匙仍锁在馆长未打开的柜中。',
    text: '顾岚从来没有拿到红钥匙，馆长的柜子也始终锁着。她掏出普通的宿舍钥匙，顺利打开只能由红钥匙开启的地下二号门。红钥匙的秘密就这样解开了。',
  },
  {
    id: 'TEST-ending-overrun',
    category: 'ending',
    basis:
      '已确认主线：全书第五章才公开证据；第一章仅发现问题，结局禁止销毁档案或消除全部后果。本章是第一章。',
    text: '顾岚刚在第一章发现疑点，便向全城公开了完整证据。所有嫌疑人立即认罪，她随后焚毁所有原始档案。此前的代价和后果全部消失，故事结束。',
  },
  {
    id: 'TEST-cross-volume-canon',
    category: 'canon',
    basis:
      '第一卷已确认且第二卷仍有效的永久规则：人眼看不见隐形墨水，只有盐水能显色。当前第二卷没有规则变更，纸面从未接触盐水或其他显色手段。',
    text: '第二卷开始，顾岚取出从未接触盐水的隐形墨水信。她在没有任何设备和显色手段的情况下，直接用肉眼清楚读出了全部隐形文字。',
  },
] as const;
it.skipIf(!process.env.RUN_REAL_NARRATIVE)(
  'REAL detection of six explicit TEST contradictions',
  async () => {
    const key = process.env.LUNAROUTE_API_KEY;
    if (!key) throw new Error('LUNAROUTE_API_KEY is required');
    useTestDb();
    setSecretStore({ get: async () => key, set: async () => {}, delete: async () => {} });
    const out = resolve(process.env.NARRATIVE_EVAL_OUTPUT!);
    if (existsSync(out) && readdirSync(out).length) throw new Error('Refusing to overwrite real evaluation evidence; choose a new output directory');
    mkdirSync(out, { recursive: true });
    let call = 0;
    const pending: Promise<void>[] = [];
    setFetchImpl(async (url, init) => {
      const id = ++call;
      writeFileSync(
        `${out}/request-${id}.json`,
        JSON.stringify({ url, body: JSON.parse(String(init?.body)) }, null, 2),
      );
      const response = await fetch(url, init);
      pending.push(
        response
          .clone()
          .text()
          .then((body) => {
            writeFileSync(
              `${out}/response-${id}.json`,
              JSON.stringify({ status: response.status, body }, null, 2),
            );
          }),
      );
      return response;
    });
    const config = await createProvider({
      name: 'REAL Lunaroute narrative TEST',
      kind: 'openai_compatible',
      baseUrl: 'https://gw.lunaroute.com/v1',
      model: 'deepseek-4.1-flash',
      contextWindow: 1048576,
      maxOutputTokens: Number(process.env.WRITING_EVAL_MAX_OUTPUT ?? 65536),
      reasoningTokens: 32000,
      reasoningEffort: process.env.WRITING_EVAL_REASONING_EFFORT as 'low' | 'medium' | 'high' | undefined,
      jsonMode: 'json_object',
      temperature: 0.1,
      extraHeaders: {},
      secretRef: 'env:LUNAROUTE_API_KEY',
      firstByteTimeoutMs: 120000,
      idleTimeoutMs: 120000,
    });
    const provider = await providerById(config.id);
    const results = [];
    for (const fixture of cases) {
      try {
        const spec = narrativeReviewPrompt({
          chapterNo: fixture.category === 'canon' ? 20 : 1,
          text: fixture.text,
          context: `TEST 虚构验收案例。资料 ID=${fixture.id}。${fixture.basis}`,
        });
        const result = await requestJson(provider, {
          ...spec,
          schema: spec.schema!.superRefine((v, ctx) => {
            for (const [i, issue] of v.issues.entries())
              try {
                anchorEvidence(fixture.text, { from: -1, to: -1, quote: issue.evidence.quote });
              } catch {
                ctx.addIssue({
                  code: 'custom',
                  path: ['issues', i, 'evidence'],
                  message: '证据必须是正文的连续逐字原文',
                });
              }
          }),
        });
        results.push({
          fixture,
          result: { ...result, value: { issues: locateNarrativeIssues(fixture.text, result.value.issues) } },
          detected: result.value.issues.some(
            (i) => i.severity === 'block' && i.category === fixture.category,
          ),
        });
      } catch (error) {
        results.push({ fixture, error: String(error), detected: false });
      }
      writeFileSync(
        `${out}/results.json`,
        JSON.stringify(
          {
            label: 'REAL review calls on TEST contradictions. Not a literary quality score.',
            model: provider.model,
            results,
          },
          null,
          2,
        ),
      );
    }
    await Promise.all(pending);
    expect(results.map((r) => ({ id: r.fixture.id, detected: r.detected }))).toEqual(
      cases.map((c) => ({ id: c.id, detected: true })),
    );
  },
  60 * 60 * 1000,
);
