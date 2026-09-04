import { describe, expect, it } from 'vitest';
import { activeNavKey, isImmersiveRoute, libraryTabOf } from '@/app/layout/navigation';

describe('libraryTabOf', () => {
  it('按查询参数分辨书架的两个 tab', () => {
    expect(libraryTabOf('?tab=novels')).toBe('novels');
    expect(libraryTabOf('?tab=documents')).toBe('documents');
    expect(libraryTabOf('')).toBe('documents');
  });
  it('不再被子串蒙混过关', () => {
    // 旧写法是 q.includes('tab=novels')，下面这些都会误判成「我的故事」。
    expect(libraryTabOf('?tab=novelsx')).toBe('documents');
    expect(libraryTabOf('?q=tab%3Dnovels')).toBe('documents');
    expect(libraryTabOf('?note=see+tab=novels')).toBe('documents');
  });
});

describe('activeNavKey', () => {
  it('书架与我的故事靠 tab 参数分开', () => {
    expect(activeNavKey('/library', '')).toBe('library');
    expect(activeNavKey('/library', '?tab=novels')).toBe('studio');
    expect(activeNavKey('/library', '?tab=documents')).toBe('library');
  });
  it('故事工坊的所有子路由都算「我的故事」', () => {
    expect(activeNavKey('/studio', '')).toBe('studio');
    expect(activeNavKey('/studio/new', '')).toBe('studio');
    expect(activeNavKey('/studio/abc123/chapters', '')).toBe('studio');
  });
  it('公共书房的子路由都算「公共书房」，通知页除外', () => {
    expect(activeNavKey('/public', '')).toBe('public');
    expect(activeNavKey('/public/feed', '')).toBe('public');
    expect(activeNavKey('/public/u/someone', '')).toBe('public');
    expect(activeNavKey('/public/notifications', '')).toBe('notifications');
  });
  it('随手问 AI 与设置', () => {
    expect(activeNavKey('/chat', '')).toBe('chat');
    expect(activeNavKey('/settings', '')).toBe('settings');
    expect(activeNavKey('/settings/providers', '')).toBe('settings');
  });
  it('路径只是前缀相同不算命中', () => {
    expect(activeNavKey('/studios', '')).toBeNull();
    expect(activeNavKey('/publicity', '')).toBeNull();
    expect(activeNavKey('/librarian', '')).toBeNull();
  });
  it('认不出的路径返回 null，侧栏不高亮任何一项', () => {
    expect(activeNavKey('/reader/abc', '')).toBeNull();
    expect(activeNavKey('/nowhere', '')).toBeNull();
  });
});

describe('isImmersiveRoute', () => {
  it('只有阅读器是沉浸式', () => {
    expect(isImmersiveRoute('/reader/doc-1')).toBe(true);
    expect(isImmersiveRoute('/reader')).toBe(false);
    expect(isImmersiveRoute('/library')).toBe(false);
  });
});
