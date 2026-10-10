/** REAL model calls on isolated TEST fiction. No simulated responses; not a literary quality evaluation. */
import { expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useTestDb } from '../helpers/testDb';
import { AssistantContextSchema } from '@the-water/shared';
import { listCharacters } from '@/db/repos/storylineRepo';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { startAssistantRuntime, sendAssistant, pauseAssistant } from '@/assistant/runtime';
import { getRun, listRuns } from '@/assistant/repository';
import { listChapters, listCurrentVersions } from '@/db/repos/chaptersRepo';
import { collectExportChapters, buildExportText, metaFromNovel } from '@/novel/export';
import { getNovel } from '@/db/repos/novelsRepo';
import { waitForJobRunnerIdle } from '@/jobs/runner';

it.skipIf(process.env.RUN_REAL_ASSISTANT !== '1')(
  'REAL unified assistant creation-to-commit on isolated TEST work',
  async () => {
    const key = process.env.DEEPSEEK_API_KEY,
      output = process.env.REAL_ASSISTANT_RECORD;
    if (!key || !output) throw new Error('DEEPSEEK_API_KEY and REAL_ASSISTANT_RECORD are required');
    if (existsSync(output)) throw new Error('Refusing to overwrite real evaluation evidence');
    const db = useTestDb();
    const record: Record<string, unknown> = {
      label: 'REAL model responses / TEST fictional inputs; not literary quality evidence',
      startedAt: new Date().toISOString(),
      model: 'deepseek-chat',
      providerBaseUrl: 'https://api.deepseek.com',
    };
    setSecretStore({ get: async () => key, set: async () => {}, delete: async () => {} });
    const exchanges: Array<Record<string, unknown>> = [];
    const pending: Array<Promise<void>> = [];
    setFetchImpl(async (url, init) => {
      const exchange: Record<string, unknown> = {
        url,
        request: JSON.parse(String(init?.body)),
        startedAt: new Date().toISOString(),
      };
      exchanges.push(exchange);
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        exchange.error = error instanceof Error ? error.message : String(error);
        exchange.finishedAt = new Date().toISOString();
        throw error;
      }
      exchange.status = response.status;
      pending.push(
        response
          .clone()
          .text()
          .then((body) => {
            exchange.response = body;
            exchange.finishedAt = new Date().toISOString();
          })
          .catch((error) => {
            exchange.responseReadError = error instanceof Error ? error.message : String(error);
          }),
      );
      return response;
    });
    try {
      await createProvider({
        name: 'REAL TEST assistant',
        kind: 'openai_compatible',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        reasoningTokens: 0,
        jsonMode: 'json_object',
        temperature: 0.2,
        extraHeaders: {},
        secretRef: 'env:DEEPSEEK_API_KEY',
        firstByteTimeoutMs: 120000,
        idleTimeoutMs: 120000,
      });
      await startAssistantRuntime();
      const run = await sendAssistant(
        '请新建标题为“TEST 统一助手验收”的虚构中文短篇小说并写完整部作品。约 800 字，完整一章，两个人物林舟和顾青。故事内容：林舟发现信封日期与旅馆登记簿不一致，顾青提醒他先核对邮戳；两人核对后发现是登记时抄错日期，林舟更正记录并将未拆的信封归还。要求：只写这件小事，动机和因果清楚，不引入犯罪或秘密组织，结尾收束。你可以自主完成规划、场景、写作和合格的局部修订，但必须独立审查、提取事实并正式提交，不得跳过审查或把问题标成误报。测试作品只用于功能验收。',
      );
      const deadline = Date.now() + 15 * 60 * 1000;
      let finished = await getRun(run.id);
      while (
        finished &&
        ['running', 'waiting_job'].includes(finished.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        finished = await getRun(run.id);
      }
      record.run = finished;
      if (finished?.state !== 'completed')
        throw new Error(
          `REAL assistant stopped: ${finished?.state}: ${finished?.error ?? 'timeout'}`,
        );
      const chapters = await listChapters(finished.novelId!);
      expect(chapters.length).toBeGreaterThan(0);
      expect(
        chapters.every(
          (c) => c.currentVersionId === c.committedVersionId && c.memoryStatus === 'valid',
        ),
      ).toBe(true);
      record.proseBeforeRevision = await listCurrentVersions(finished.novelId!);
      const revision = await sendAssistant(
        '请把林舟的人物设定改为邮局见习员，随后修改受影响的章节：他负责递还未拆的信封，顾青负责更正旅馆登记簿，保留核对邮戳的因果链。完成必要的人物和规划更新、正文改写、独立审查、事实提取与正式提交。保持 TEST 标记。这是对已有作品的修改，不新建作品。',
        AssistantContextSchema.parse({ novelId: finished.novelId }),
      );
      const revisionDeadline = Date.now() + 15 * 60 * 1000;
      let revised = await getRun(revision.id);
      while (
        revised &&
        ['running', 'waiting_job'].includes(revised.state) &&
        Date.now() < revisionDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        revised = await getRun(revision.id);
      }
      record.revisionRun = revised;
      if (revised?.state !== 'completed')
        throw new Error(`REAL revision stopped: ${revised?.state}: ${revised?.error ?? 'timeout'}`);
      expect(JSON.stringify(await listCharacters(finished.novelId!))).toContain('邮局');
      record.prose = await listCurrentVersions(finished.novelId!);
      expect(JSON.stringify(record.prose)).toContain('邮局');
      expect(
        (await listChapters(finished.novelId!)).every(
          (c) => c.currentVersionId === c.committedVersionId && c.memoryStatus === 'valid',
        ),
      ).toBe(true);
      const novel = (await getNovel(finished.novelId!))!;
      // Exercise the actual export renderer separately; native dialog acceptance is a separate check.
      const exported = buildExportText(
        await collectExportChapters(novel.id),
        metaFromNovel(novel),
        'txt',
      );
      expect(exported).toContain('TEST');
      record.exportedText = exported;
      record.status = 'passed';
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      for (const run of await listRuns())
        if (['running', 'waiting_job'].includes(run.state)) await pauseAssistant(run.id, true);
      await waitForJobRunnerIdle();
      await Promise.all(pending);
      record.exchanges = exchanges;
      record.finishedAt = new Date().toISOString();
      for (const table of [
        'assistant_runs',
        'assistant_operations',
        'writing_proposals',
        'generation_jobs',
        'job_steps',
        'chapter_reviews',
        'chapter_commits',
        'chapters',
        'usage_events',
      ])
        record[table] = await db.select(`SELECT * FROM ${table}`);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(record, null, 2));
      db.raw.close();
    }
  },
  32 * 60 * 1000,
);
