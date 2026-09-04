import { Hono } from 'hono';
import {
  MarkNotificationsReadRequestSchema,
  NotificationQuerySchema,
  type MarkNotificationsReadRequest,
  type NotificationQuery,
} from '@the-water/shared';
import type { AppDeps, AppEnv } from '../../context';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getValid, validate } from '../../middleware/validate';
import * as svc from './service';

export function notificationRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get('/me/notifications', requireAuth(), validate('query', NotificationQuerySchema), (c) => {
    return c.json(svc.listNotifications(deps, currentUser(c), getValid<NotificationQuery>(c, 'query')));
  });

  // 小红点只要一个数字，单独开一个便宜的端点，桌面端可以高频轮询。
  r.get('/me/notifications/unread-count', requireAuth(), (c) => {
    return c.json({ unreadCount: svc.unreadCount(deps, currentUser(c).id) });
  });

  r.post('/me/notifications/read', requireAuth(), validate('json', MarkNotificationsReadRequestSchema), (c) => {
    return c.json(svc.markRead(deps, currentUser(c), getValid<MarkNotificationsReadRequest>(c, 'json')));
  });

  return r;
}
