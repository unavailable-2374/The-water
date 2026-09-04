import { Link } from 'react-router';
import { Avatar } from './Avatar';
import { cn } from './ui';

export interface UserChipUser {
  id: string;
  handle: string;
  displayName: string;
}

/** 作者署名：头像 + 昵称 + @用户名，点击进作者主页。 */
export function UserChip({
  user,
  size = 'sm',
  showHandle = true,
  className,
}: {
  user: UserChipUser;
  size?: 'xs' | 'sm' | 'md';
  showHandle?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={authorPath(user)}
      onClick={(e) => e.stopPropagation()}
      className={cn('group inline-flex min-w-0 items-center gap-2 text-ink-700 transition hover:text-tea-700 dark:text-ink-200 dark:hover:text-tea-200', className)}
    >
      <Avatar seed={user.handle || user.id} name={user.displayName} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{user.displayName}</span>
        {showHandle && user.handle && <span className="block truncate text-[11px] text-ink-400">@{user.handle}</span>}
      </span>
    </Link>
  );
}

/** 作者主页地址：有 @用户名走 handle，老服务器没有时退回 id。 */
export function authorPath(user: { id: string; handle?: string }): string {
  return `/public/u/${encodeURIComponent(user.handle || user.id)}`;
}
