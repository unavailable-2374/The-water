import { describe, expect, it } from 'vitest';
import type { Notification } from '@the-water/shared';
import { parseMentions } from '@the-water/shared';
import {
  groupNotifications,
  notificationDayLabel,
  notificationIcon,
  notificationTarget,
  notificationTone,
  unreadBadgeText,
} from '@/features/community/notifications/kinds';
import { splitMentions } from '@/features/community/comments/mentions';

const base: Notification = {
  id: 'n1',
  kind: 'liked',
  refType: 'novel',
  refId: 'novel-1',
  title: '陈舟 喜欢了《灯下长街》',
  body: '',
  actor: { id: 'u2', handle: 'chenzhou', displayName: '陈舟' },
  novelId: 'novel-1',
  readAt: null,
  createdAt: '2026-09-04T08:00:00.000Z',
};

describe('notificationIcon / notificationTone', () => {
  it('maps every kind to an icon', () => {
    expect(notificationIcon('followed')).toBe('follow');
    expect(notificationIcon('liked')).toBe('like');
    expect(notificationIcon('comment_liked')).toBe('like');
    expect(notificationIcon('replied')).toBe('comment');
    expect(notificationIcon('mentioned')).toBe('comment');
    expect(notificationIcon('forked')).toBe('fork');
    expect(notificationIcon('badge')).toBe('badge');
    expect(notificationIcon('moderation_novel')).toBe('shield');
    expect(notificationIcon('moderation_comment')).toBe('shield');
  });
  it('flags moderation notices', () => {
    expect(notificationTone('moderation_novel')).toBe('cinnabar');
    expect(notificationTone('badge')).toBe('tea');
    expect(notificationTone('liked')).toBe('ink');
  });
});

describe('notificationTarget', () => {
  it('routes novels, comments and follows', () => {
    expect(notificationTarget(base)).toBe('/public/novel-1');
    expect(notificationTarget({ ...base, refType: 'comment', refId: 'c1', novelId: 'novel-9' })).toBe('/public/novel-9');
    expect(notificationTarget({ ...base, refType: 'user', refId: 'u2' })).toBe('/public/u/chenzhou');
  });
  it('退回 refId：老服务器没带 actor 时也要能跳', () => {
    expect(notificationTarget({ refType: 'user', refId: 'u2', novelId: null, actor: null })).toBe('/public/u/u2');
  });
  it('徽章与孤儿留言不可点', () => {
    expect(notificationTarget({ ...base, refType: 'badge', refId: 'first_publish', novelId: null })).toBeNull();
    expect(notificationTarget({ ...base, refType: 'comment', refId: 'c1', novelId: null })).toBeNull();
    expect(notificationTarget({ ...base, refType: 'system', refId: 'x', novelId: null })).toBeNull();
  });
  it('对 id 做转义', () => {
    expect(notificationTarget({ ...base, refId: 'a/b' })).toBe('/public/a%2Fb');
  });
});

describe('notificationDayLabel / groupNotifications', () => {
  const now = new Date('2026-09-04T12:00:00');
  it('labels by day distance', () => {
    expect(notificationDayLabel('2026-09-04T01:00:00', now)).toBe('今天');
    expect(notificationDayLabel('2026-09-03T23:00:00', now)).toBe('昨天');
    expect(notificationDayLabel('2026-09-01T10:00:00', now)).toBe('本周');
    expect(notificationDayLabel('2026-08-01T10:00:00', now)).toBe('更早');
    expect(notificationDayLabel('不是时间', now)).toBe('更早');
  });
  it('groups consecutive items and keeps server order', () => {
    const items = [
      { ...base, id: 'a', createdAt: '2026-09-04T09:00:00' },
      { ...base, id: 'b', createdAt: '2026-09-04T08:00:00' },
      { ...base, id: 'c', createdAt: '2026-09-03T08:00:00' },
    ];
    const groups = groupNotifications(items, now);
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groupNotifications([], now)).toEqual([]);
  });
});

describe('unreadBadgeText', () => {
  it('hides zero and caps at 99+', () => {
    expect(unreadBadgeText(0)).toBeNull();
    expect(unreadBadgeText(-1)).toBeNull();
    expect(unreadBadgeText(1)).toBe('1');
    expect(unreadBadgeText(99)).toBe('99');
    expect(unreadBadgeText(100)).toBe('99+');
  });
});

describe('@提及：渲染切分与服务端解析同一套规则', () => {
  it('splits mentions out of the body', () => {
    expect(splitMentions('你好 @linwan 再见')).toEqual([
      { kind: 'text', value: '你好 ' },
      { kind: 'mention', value: 'linwan' },
      { kind: 'text', value: ' 再见' },
    ]);
    expect(splitMentions('@linwan 开头也算')[0]).toEqual({ kind: 'mention', value: 'linwan' });
    expect(splitMentions('没有提及')).toEqual([{ kind: 'text', value: '没有提及' }]);
  });
  it('ignores emails and too-short handles', () => {
    expect(splitMentions('写信到 a@bc.com').every((s) => s.kind === 'text')).toBe(true);
    expect(splitMentions('@ab 太短了').every((s) => s.kind === 'text')).toBe(true);
  });
  it('matches the shared parser used by the server', () => {
    for (const body of ['你好 @linwan 再见', '@a_b_c 与 @linwan', 'a@bc.com', '@ab', '@linwan@chenzhou']) {
      const rendered = splitMentions(body)
        .filter((s) => s.kind === 'mention')
        .map((s) => s.value.toLowerCase());
      expect([...new Set(rendered)]).toEqual(parseMentions(body));
    }
  });
});
