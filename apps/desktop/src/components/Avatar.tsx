import { avatarGradient, avatarInitial } from '@/community/avatar';
import { cn } from './ui';

const SIZES = {
  xs: 'h-6 w-6 text-[11px]',
  sm: 'h-8 w-8 text-sm',
  md: 'h-10 w-10 text-base',
  lg: 'h-14 w-14 text-xl',
  xl: 'h-20 w-20 text-3xl',
} as const;

/** 由 @用户名（没有就用 id）生成的确定性头像：一个字 + 一层暖色渐变。 */
export function Avatar({
  seed,
  name,
  size = 'md',
  className,
}: {
  seed: string;
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-serif font-semibold text-paper-0/95 shadow-soft', SIZES[size], className)}
      style={{ background: avatarGradient(seed || name) }}
    >
      {avatarInitial(name)}
    </div>
  );
}
