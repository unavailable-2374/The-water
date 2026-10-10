import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityStatus, TaskProgress } from '@/components/Activity';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { Bubble } from '@/components/conversation/Bubble';
import { isJobWorking, isStepAwaitingReview, jobActivityMessage, jobDisplayOrder } from '@/jobs/presentation';
import type { Job } from '@/db/repos/jobsRepo';
import { t } from '@/i18n';

// TEST rendering fixtures; these do not represent real running model tasks.
describe('TEST activity feedback lifecycle', () => {
  it('distinguishes the current review checkpoint from actual failed steps', () => {
    const job = { status: 'awaiting_review' as Job['status'], progress: { done: 0, total: 2, currentStepId: 'TEST review', charsSoFar: 0, message: '' } };
    expect(isStepAwaitingReview(job, { id: 'TEST review', status: 'failed' })).toBe(true);
    expect(isStepAwaitingReview(job, { id: 'TEST other failure', status: 'failed' })).toBe(false);
    expect(isStepAwaitingReview({ ...job, status: 'failed' }, { id: 'TEST review', status: 'failed' })).toBe(false);
  });
  it('only running jobs present generation activity, and other states replace stale messages', () => {
    const statuses: Job['status'][] = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'awaiting_review'];
    for (const status of statuses) {
      expect(isJobWorking(status)).toBe(status === 'running');
      const message = jobActivityMessage({ status, progress: { done: 0, total: 1, currentStepId: null, charsSoFar: 0, message: 'TEST stale generating message' } });
      expect(message).toBe(status === 'running' ? 'TEST stale generating message' : t.jobs.status[status]);
    }
    expect(jobDisplayOrder('running')).toBeLessThan(jobDisplayOrder('awaiting_review'));
    expect(jobDisplayOrder('awaiting_review')).toBeLessThan(jobDisplayOrder('failed'));
  });
  it('activity motion never changes the actual completed-step percentage', () => {
    const active = renderToStaticMarkup(createElement(TaskProgress, { percent: 0, active: true, label: 'TEST progress' }));
    expect(active).toContain('activity-track');
    expect(active).toContain('aria-valuenow="0"');
    const paused = renderToStaticMarkup(createElement(TaskProgress, { percent: 25, active: false, label: 'TEST progress' }));
    expect(paused).not.toContain('activity-track');
    expect(paused).toContain('aria-valuenow="25"');
    expect(paused).toContain('width:25%');
  });
  it('thinking animates before the first delta, streaming has a cursor, and completed messages have no animation', () => {
    const thinking = renderToStaticMarkup(createElement(Bubble, { role: 'assistant', text: '', streaming: true }));
    expect(thinking).toContain('activity-dots');
    expect(thinking).toContain('role="status"');
    const streaming = renderToStaticMarkup(createElement(Bubble, { role: 'assistant', text: 'TEST output', streaming: true }));
    expect(streaming).toContain('activity-cursor');
    const finished = renderToStaticMarkup(createElement(Bubble, { role: 'assistant', text: 'TEST output' }));
    expect(finished).not.toContain('activity-cursor');
    expect(finished).not.toContain('activity-dots');
  });
  it('loading errors replace animation with their actual error and a retry action', () => {
    const html = renderToStaticMarkup(createElement(AsyncNotice, { error: new Error('TEST load refused'), retry: () => {} }));
    expect(html).toContain('TEST load refused');
    expect(html).toContain('role="alert"');
    expect(html).toContain('<button');
    expect(html).not.toContain('activity-dots');
  });
  it('elapsed time is displayed without announcing a ticking timer every second', () => {
    const html = renderToStaticMarkup(createElement(ActivityStatus, { label: 'TEST waiting', elapsed: true }));
    expect(html).toContain('aria-live="off"');
    expect(html).toContain('role="status"');
  });
});
