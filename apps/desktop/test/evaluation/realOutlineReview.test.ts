/** REAL model review of explicitly labeled TEST fiction. No production author content. */
import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { providersForPurposes } from '@/jobs/runner';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { proposeDocumentPlan, listDocumentPlans, acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import { reviewOutlineProposal } from '@/novel/outlineReview';
import { OutlineReviewStateSchema, outlineReviewBlocks } from '@the-water/shared';

it.skipIf(process.env.RUN_REAL_OUTLINE_REVIEW !== '1')('REAL independent review detects TEST rebirth contradiction and respects TEST quiet open ending', async () => {
  const key = process.env.LUNAROUTE_API_KEY; if (!key) throw new Error('LUNAROUTE_API_KEY is required');
  const db = useTestDb(); setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined }); setFetchImpl(fetch);
  const record: Record<string, unknown> = { label: 'REAL model judgments on TEST fictional outlines. Not an objective quality score.', date: new Date().toISOString(), cases: [] };
  try {
    const config = await createProvider({ name: 'REAL TEST outline reviewer', kind: 'openai_compatible', baseUrl: 'https://gw.lunaroute.com/v1', model: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000, reasoningEffort: 'low', jsonMode: 'json_schema', temperature: 0.2, extraHeaders: {}, secretRef: 'TEST environment', firstByteTimeoutMs: 120000, idleTimeoutMs: 120000 });
    const provider = (await providersForPurposes({ params: { providerIds: { planning: config.id } }, providerId: null }, ['planning'])).planning!;
    for (const kind of ['contradiction','quiet'] as const) {
      const premise = kind === 'contradiction' ? 'TEST 虚构重生故事：林川在2022年死亡后回到2019年。只有记忆回到过去，任何物件和电子数据不能跨时间线。目标是在2019年揭露陷害，高潮必须以有效取得的财务文件为基础。' : 'TEST 虚构日常心理短篇：退休的林阿姨与新邻居小陶，从隔门接饭盒，到允许对方进屋，最终主动邀对方吃饭。主要体验是陪伴、细小信任积累。全文一个月，完整出版约六千字。结局开放，只回应是否愿意建立联系，不承诺解决丧偶悲伤或爱情。';
      const novel = await createNovel({ title: `TEST ${kind}`, premise, targetChars: 6000, requirements: { ...defaultRequirements(), docType: 'short-story', genre: kind === 'contradiction' ? '重生悬疑' : '日常治愈', audience: '成年读者' } });
      const after = await buildStorylineDoc(novel.id, novel.premise, []);
      after.settings = [{ id: nanoid(), name: 'TEST 核心条件', kind: 'other', triggerKeys: [], priority: 0, constant: false, description: kind === 'contradiction' ? 'TEST 林川在2021年才首次收集并藏好文件，2019年尚未收集；只有记忆重生。' : 'TEST 饭盒是邻居当天做饭留下的一份，无超自然能力和秘密。' }];
      after.arcs = kind === 'contradiction' ? [{ id: nanoid(), title: 'TEST 取证与揭露', summary: 'TEST 2019年林川醒来，立即打开储物柜，取出他在2021年才收集和藏进去的财务文件，直接以此在董事会揭露反派并获胜。没有其他取证过程。', startChapterNo: 1, endChapterNo: 3 }] : [
        { id: nanoid(), title: 'TEST 隔门', summary: 'TEST 第一周小陶做多了饭，敲门分享。林阿姨只在门缝接过饭盒；她怕让人看到丈夫遗物，却记住邻居忌口，第二天把洗净饭盒和一份不辣的小菜放回门外。', startChapterNo: 1, endChapterNo: 1 },
        { id: nanoid(), title: 'TEST 进屋', summary: 'TEST 第二周小陶不追问遗物，也不催她整理；连续几次交换小菜后，林阿姨主动让小陶进屋取盒子，允许她看见相片，谈了一句丈夫喜欢的味道。关系从礼节变成有限信任。', startChapterNo: 2, endChapterNo: 2 },
        { id: nanoid(), title: 'TEST 同桌', summary: 'TEST 月底小陶忙于工作错过晚饭，林阿姨第一次主动做两份并邀她同桌。她仍难过，不承诺走出丧偶，但愿意让一个人进入生活。小说停在她打开门说饭好了，回应由接纳帮助到主动联系的变化。', startChapterNo: 3, endChapterNo: 3 }];
      const id = await proposeDocumentPlan(novel.id, after, 'TEST outline', { outlineDone: true, logline: premise, outlineReviewRequired: true });
      await reviewOutlineProposal(novel.id, id, { provider });
      const p = (await listDocumentPlans(novel.id)).find(p => p.id === id)!;
      const review = OutlineReviewStateSchema.parse(p.meta.outlineReview).report!;
      (record.cases as unknown[]).push({ kind, premise, outline: after, review });
      expect(review.checks).toHaveLength(12); expect(review.timeline.length).toBeGreaterThan(0);
      if (kind === 'contradiction') {
        expect(review.findings.some(f => f.dimension === 'causality' && f.kind === 'contradiction' && f.priority === 'critical')).toBe(true);
        await expect(acceptDocumentPlan(novel.id, id)).rejects.toThrow('关键矛盾');
      } else {
        expect(outlineReviewBlocks(review)).toBe(false);
        await acceptDocumentPlan(novel.id, id);
      }
    }
    record.status = 'passed';
  } catch (e) { record.status = 'failed'; record.error = String(e); record.rawErrorOutput = e && typeof e === 'object' && 'raw' in e ? e.raw : null; throw e; }
  finally { record.usage = await db.select('SELECT model,input_tokens,output_tokens FROM usage_events'); if (process.env.REAL_OUTLINE_REVIEW_RECORD) writeFileSync(process.env.REAL_OUTLINE_REVIEW_RECORD, JSON.stringify(record,null,2)); db.raw.close(); }
}, 600000);
