/** Opt-in REAL crash/failure recovery from a saved TEST experiment. Never simulates model output. */
import { it, expect } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { useTestDb } from '../helpers/testDb';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { getJob, listSteps } from '@/db/repos/jobsRepo';
import { listProviders, updateProvider, type ProviderInput } from '@/db/repos/providersRepo';
import { createVersion, getVersion, listChapters, type Chapter, type ChapterVersion } from '@/db/repos/chaptersRepo';
import { retryStep, suspendJobRunnerForRestore } from '@/jobs/runner';
it.skipIf(!process.env.RUN_REAL_RESUME)(
  'REAL resumes a saved failed TEST task without rewriting committed chapters',
  async () => {
    const key = process.env.LUNAROUTE_API_KEY;
    if (!key) throw new Error('LUNAROUTE_API_KEY is required');
    const deadlineMinutes = Number(process.env.WRITING_EVAL_DEADLINE_MINUTES ?? 60);
    if (!Number.isSafeInteger(deadlineMinutes) || deadlineMinutes < 1 || deadlineMinutes > 240)
      throw new Error('WRITING_EVAL_DEADLINE_MINUTES must be an integer between 1 and 240');
    const out = resolve(process.env.WRITING_EVAL_OUTPUT!),
      source = resolve(process.env.WRITING_EVAL_RESUME_DB!);
    if (existsSync(out) && readdirSync(out).length)
      throw new Error('Refusing to overwrite real evaluation evidence; choose a new output directory');
    mkdirSync(out, { recursive: true });
    const diff = execFileSync('git', ['diff', 'HEAD']);
    writeFileSync(`${out}/source.patch`, diff);
    const paths = execFileSync(
      'git',
      ['-C', resolve('../..'), 'ls-files', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
    const hashes: Record<string, string> = {};
    for (const path of paths) {
      const bytes = readFileSync(resolve('../..', path));
      hashes[path] = createHash('sha256').update(bytes).digest('hex');
      const target = resolve(out, 'source-untracked', path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(
      `${out}/source.json`,
      JSON.stringify(
        {
          head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          diffSha256: createHash('sha256').update(diff).digest('hex'),
          untracked: hashes,
          resumedFrom: source,
          resumedDatabaseSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const working = resolve(out, 'working.sqlite');
    copyFileSync(source, working);
    const db = useTestDb(working);
    if (!db.raw.prepare("PRAGMA table_info(llm_providers)").all().some((c: any) => c.name === 'reasoning_effort')) {
      db.raw.exec(readFileSync(resolve('src-tauri/migrations/0010_reasoning_effort.sql'), 'utf8'));
    }
    // Supplemental recovery may explicitly change the output cap. Record both
    // settings; never silently change the sealed comparison's conditions.
    const providerBefore = await listProviders();
    const overrides: Partial<ProviderInput> = {};
    if (process.env.WRITING_EVAL_MAX_OUTPUT) {
      const maxOutputTokens = Number(process.env.WRITING_EVAL_MAX_OUTPUT);
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
        throw new Error('WRITING_EVAL_MAX_OUTPUT must be a positive integer');
      overrides.maxOutputTokens = maxOutputTokens;
    }
    if (process.env.WRITING_EVAL_REASONING_RESERVE) {
      const reasoningTokens = Number(process.env.WRITING_EVAL_REASONING_RESERVE);
      if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)
        throw new Error('WRITING_EVAL_REASONING_RESERVE must be a nonnegative integer');
      overrides.reasoningTokens = reasoningTokens;
    }
    if (process.env.WRITING_EVAL_JSON_MODE) {
      if (!['json_object', 'json_schema'].includes(process.env.WRITING_EVAL_JSON_MODE))
        throw new Error('WRITING_EVAL_JSON_MODE must be json_object or json_schema');
      overrides.jsonMode = process.env.WRITING_EVAL_JSON_MODE as 'json_object' | 'json_schema';
    }
    if (process.env.WRITING_EVAL_REASONING_EFFORT) {
      const effort = process.env.WRITING_EVAL_REASONING_EFFORT;
      if (!['low', 'medium', 'high'].includes(effort)) throw new Error('WRITING_EVAL_REASONING_EFFORT must be low, medium or high');
      overrides.reasoningEffort = effort as 'low' | 'medium' | 'high';
    }
    for (const provider of providerBefore) await updateProvider(provider.id, overrides);
    writeFileSync(`${out}/provider-settings.json`, JSON.stringify({ before: providerBefore, after: await listProviders() }, null, 2));
    setSecretStore({ get: async () => key, set: async () => {}, delete: async () => {} });
    let call = 0;
    const pending: Promise<void>[] = [];
    setFetchImpl(async (url, init) => {
      const id = String(++call).padStart(3, '0');
      writeFileSync(
        `${out}/request-${id}.json`,
        JSON.stringify(
          { started: new Date().toISOString(), url, body: JSON.parse(String(init?.body)) },
          null,
          2,
        ),
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
          })
          .catch((error: unknown) => {
            writeFileSync(`${out}/response-${id}.json`, JSON.stringify({ status: response.status, finished: new Date().toISOString(), body: '', captureError: String(error), usageKnown: false }, null, 2));
          }),
      );
      return response;
    });
    const rows = await db.select<{ id: string }>(
      "SELECT id FROM generation_jobs WHERE status IN ('failed','awaiting_review') ORDER BY created_at DESC",
    );
    expect(rows).toHaveLength(1);
    const job = (await getJob(rows[0]!.id))!;
    const before = await listChapters(job.novelId),
      committed = await Promise.all(
        before
          .filter((c) => c.committedVersionId)
          .map(async (c) => ({ chapterId: c.id, version: (await getVersion(c.committedVersionId!))! })),
      );
    expect(committed.length).toBeGreaterThan(0);
    if (process.env.WRITING_EVAL_AUTHOR_EDIT) {
      const authorInput = readFileSync(resolve(process.env.WRITING_EVAL_AUTHOR_EDIT), 'utf8');
      const edit = JSON.parse(authorInput) as { label: string; chapterNo: number; content: string; rationale: string };
      if (!edit.label.startsWith('TEST AUTHOR EDIT') || !edit.rationale.trim())
        throw new Error('Author intervention must be explicitly labelled TEST AUTHOR EDIT with rationale');
      const chapter = before.find(c => c.chapterNo === edit.chapterNo);
      if (!chapter || chapter.committedVersionId) throw new Error('Author recovery edits only an uncommitted TEST chapter');
      writeFileSync(`${out}/author-intervention.json`, authorInput);
      await createVersion({ chapterId: chapter.id, content: edit.content, source: 'user_edit', expectedWorkingVersionId: chapter.currentVersionId });
    }
    const failed = (await listSteps(job.id)).find((s) => s.status === 'failed');
    expect(failed).toBeDefined();
    await retryStep(failed!.id);
    const deadline = Date.now() + deadlineMinutes * 60 * 1000;
    let status = await getJob(job.id);
    while (status && ['queued', 'running', 'pausing'].includes(status.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      status = await getJob(job.id);
    }
    const deadlineReached = !!status && ['queued', 'running', 'pausing'].includes(status.status);
    // Never close SQLite while the runner can still write after a timed-out experiment.
    if (deadlineReached) {
      await suspendJobRunnerForRestore();
      status = await getJob(job.id);
    }
    await Promise.all(pending);
    const chapters: Array<{ chapter: Chapter; version: ChapterVersion | null }> = [];
    for (const c of await listChapters(job.novelId))
      chapters.push({
        chapter: c,
        version: c.committedVersionId ? await getVersion(c.committedVersionId) : null,
      });
    const preserved = committed.every((c) =>
      chapters.some(
        (x) =>
          x.chapter.id === c.chapterId &&
          x.chapter.committedVersionId === c.version.id &&
          x.version?.content === c.version.content,
      ),
    );
    writeFileSync(
      `${out}/result.json`,
      JSON.stringify(
        {
          label: 'REAL recovery from saved failed TEST input',
          status,
          resumedFrom: source,
          previouslyCommittedPreserved: preserved,
          deadlineMinutes,
          deadlineReached,
          chapters,
          steps: await listSteps(job.id),
          usage: await db.select('SELECT * FROM usage_events'),
          qualityConclusion: 'Not assessed. Human blinded ratings required.',
        },
        null,
        2,
      ),
    );
    db.raw.prepare('VACUUM INTO ?').run(resolve(out, 'database.sqlite'));
    db.raw.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(working + suffix, { force: true });
    expect(preserved).toBe(true);
    expect(status?.status, `Real recovery stopped: ${status?.error}`).toBe('completed');
  },
  (Number(process.env.WRITING_EVAL_DEADLINE_MINUTES ?? 60) + 5) * 60 * 1000,
);
