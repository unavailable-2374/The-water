/** Opt-in REAL network experiment. TEST denotes the fictional input, not simulated output. */
import { it, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { useTestDb } from '../helpers/testDb';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { upsertChapterPlan, listChapters, listVersions } from '@/db/repos/chaptersRepo';
import { replaceStorylineRows } from '@/db/repos/storylineRepo';
import { createJob, getJob, listSteps } from '@/db/repos/jobsRepo';
import { saveStyleCheckConfig } from '@/novel/config';
import { defaultRequirements } from '@/novel/types';
import { emptyStoryline, emptyVoice, emptyLore, emptyStyleProfile } from '@the-water/shared';
import { planGenerate } from '@/jobs/planner';
import { kick } from '@/jobs/runner';

it.skipIf(!process.env.RUN_REAL_WRITING)(
  'REAL fixed-input Lunaroute experiment (no self-scored quality claim)',
  async () => {
    const key = process.env.LUNAROUTE_API_KEY;
    if (!key) throw new Error('LUNAROUTE_API_KEY is required');
    const out = resolve(process.env.WRITING_EVAL_OUTPUT!);
    if (existsSync(out) && readdirSync(out).length) throw new Error('Refusing to overwrite real evaluation evidence; choose a new output directory');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      `${out}/source.json`,
      JSON.stringify(
        {
          head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          diffSha256: createHash('sha256')
            .update(execFileSync('git', ['diff', 'HEAD']))
            .digest('hex'),
          untracked: Object.fromEntries(
            execFileSync(
              'git',
              ['-C', resolve('../..'), 'ls-files', '--others', '--exclude-standard', '-z'],
              { encoding: 'utf8' },
            )
              .split('\0')
              .filter(Boolean)
              .map((p) => [
                p,
                createHash('sha256')
                  .update(readFileSync(resolve('../..', p)))
                  .digest('hex'),
              ]),
          ),
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    writeFileSync(`${out}/source.patch`, execFileSync('git', ['diff', 'HEAD']));
    for (const p of execFileSync(
      'git',
      ['-C', resolve('../..'), 'ls-files', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean)) {
      const target = resolve(out, 'source-untracked', p);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, readFileSync(resolve('../..', p)));
    }
    const input = JSON.parse(readFileSync(resolve(process.env.WRITING_EVAL_INPUT ?? '../../docs/writing/evaluation/TEST-input.json'), 'utf8'));
    const db = useTestDb();
    setSecretStore({ get: async () => key, set: async () => undefined, delete: async () => undefined });
    const pending: Promise<void>[] = [];
    let call = 0;
    setFetchImpl(async (url, init) => {
      const id = String(++call).padStart(3, '0'),
        started = new Date().toISOString();
      // Only the request body, never HTTP authorization headers, is persisted.
      writeFileSync(
        `${out}/request-${id}.json`,
        JSON.stringify({ started, url, body: JSON.parse(String(init?.body)) }, null, 2),
      );
      const response = await fetch(url, init);
      pending.push(
        response
          .clone()
          .text()
          .then((body) => {
            writeFileSync(
              `${out}/response-${id}.json`,
              JSON.stringify({ status: response.status, finished: new Date().toISOString(), body }, null, 2),
            );
          }),
      );
      return response;
    });
    await createProvider({
      name: 'REAL Lunaroute',
      kind: 'openai_compatible',
      baseUrl: 'https://gw.lunaroute.com/v1',
      model: 'deepseek-4.1-flash',
      contextWindow: 1048576,
      maxOutputTokens: Number(process.env.WRITING_EVAL_MAX_OUTPUT ?? 65536),
      reasoningTokens: Number(process.env.WRITING_EVAL_REASONING_RESERVE ?? 32000),
      reasoningEffort: process.env.WRITING_EVAL_REASONING_EFFORT as 'low' | 'medium' | 'high' | undefined,
      jsonMode: 'json_object',
      temperature: 0.7,
      extraHeaders: {},
      secretRef: 'env:LUNAROUTE_API_KEY',
      firstByteTimeoutMs: 120000,
      idleTimeoutMs: 120000,
    });
    await saveStyleCheckConfig({ maxRevisions: 2 });
    const novel = await createNovel({
      title: input.title,
      premise: input.premise,
      requirements: defaultRequirements(),
      targetChars: 3000,
    });
    const doc = {
      ...emptyStoryline(),
      premise: input.premise,
      characters: input.characters.map((c: any) => ({
        ...emptyVoice(),
        id: c.id,
        name: c.name,
        aliases: [],
        role: c.role,
        description: `${c.description}目标：${c.goal}；动机：${c.motivation}；矛盾：${c.contradiction}`,
        arc: c.arc,
        relationships: [],
        redlines: c.redlines,
      })),
      settings: input.rules.map((r: string, i: number) => ({
        ...emptyLore(),
        id: `TEST-rule-${i}`,
        name: `TEST rule ${i}`,
        kind: 'rule' as const,
        description: r,
        constant: true,
      })),
      styleProfile: emptyStyleProfile({ id: 'TEST-style', name: 'TEST 克制、具体行动、对白有分歧' }),
    };
    await replaceStorylineRows(novel.id, doc);
    for (const [i, c] of input.chapters.entries())
      await upsertChapterPlan(novel.id, {
        chapterNo: i + 1,
        title: c.title,
        goal: `${c.time}，${c.location}。${c.goal}阻力：${c.obstacle}；转折：${c.turn}；结果：${c.outcome}`,
        targetChars: 1000,
        povCharacterId: c.pov,
        endHook: c.outcome,
      });
    if (process.env.WRITING_EVAL_VARIANT !== 'baseline') {
      const { saveWritingCard } = await import('@/db/repos/writingRepo');
      await saveWritingCard(
        novel.id,
        {
          kind: 'brief',
          data: {
            premise: input.premise,
            mainline: input.premise,
            ending: input.rules[3],
            audience: '成人悬疑读者',
            constraints: input.rules,
            rollingChapters: 5,
          },
        },
        { confirmed: true },
      );
      for (const [i, c] of input.chapters.entries()) {
        const chapter = (await listChapters(novel.id))[i]!;
        await saveWritingCard(
          novel.id,
          {
            kind: 'scene',
            data: {
              title: c.title,
              volumeId: null,
              povCharacterId: c.pov,
              time: c.time,
              location: c.location,
              characterIds: c.characters,
              goal: c.goal,
              obstacle: c.obstacle,
              turn: c.turn,
              outcome: c.outcome,
              targetChars: 1000,
              threadIds: [],
              dependencyIds: [],
            },
          },
          { chapterId: chapter.id, confirmed: true },
        );
      }
    }
    const job = await createJob({
      novelId: novel.id,
      type: 'generate_novel',
      params: { label: 'REAL experiment using TEST fictional input' },
      providerId: null,
      steps: planGenerate(await listChapters(novel.id), { styleCheck: true }),
    });
    kick();
    const deadline = Date.now() + 60 * 60 * 1000;
    let status = await getJob(job.id);
    while (status && ['queued', 'running', 'pausing'].includes(status.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      status = await getJob(job.id);
    }
    await Promise.all(pending);
    db.raw.prepare('VACUUM INTO ?').run(resolve(out, 'database.sqlite'));
    const chapters = [];
    for (const c of await listChapters(novel.id))
      chapters.push({ chapter: c, versions: await listVersions(c.id) });
    writeFileSync(
      `${out}/result.json`,
      JSON.stringify(
        {
          variant: process.env.WRITING_EVAL_VARIANT,
          model: 'deepseek-4.1-flash',
          input,
          status,
          steps: await listSteps(job.id),
          chapters,
          usage: await db.select('SELECT * FROM usage_events'),
          reviews: await db.select('SELECT * FROM chapter_reviews'),
          qualityConclusion: 'Not assessed. Human blinded ratings required.',
        },
        null,
        2,
      ),
    );
    expect(status?.status, `Real pipeline stopped: ${status?.error}`).toBe('completed');
  },
  65 * 60 * 1000,
);
