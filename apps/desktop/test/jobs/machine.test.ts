import { describe, expect, it } from 'vitest';
import { canTransition, transition } from '@/jobs/machine';

describe('job state machine', () => {
  it('happy path', () => {
    let s = transition('queued', 'start');
    s = transition(s, 'stepDone');
    s = transition(s, 'allDone');
    expect(s).toBe('completed');
  });
  it('pause/resume', () => {
    expect(transition('running', 'pause')).toBe('pausing');
    expect(transition('pausing', 'aborted')).toBe('paused');
    expect(transition('paused', 'resume')).toBe('running');
  });
  it('cancel from running & paused', () => {
    expect(transition('running', 'cancel')).toBe('cancelling');
    expect(transition('cancelling', 'aborted')).toBe('cancelled');
    expect(transition('paused', 'cancel')).toBe('cancelled');
  });
  it('failure and retry', () => {
    expect(transition('running', 'stepFailed')).toBe('failed');
    expect(transition('failed', 'retry')).toBe('running');
  });
  it('boot mapping', () => {
    expect(transition('running', 'boot')).toBe('paused');
    expect(transition('pausing', 'boot')).toBe('paused');
    expect(transition('cancelling', 'boot')).toBe('cancelled');
    expect(transition('completed', 'boot')).toBe('completed');
  });
  it('rejects illegal transitions', () => {
    expect(() => transition('completed', 'resume')).toThrow();
    expect(canTransition('cancelled', 'start')).toBe(false);
    expect(canTransition('queued', 'pause')).toBe(false);
  });
});
