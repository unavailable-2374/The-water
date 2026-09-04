import type { Level } from '@the-water/shared';
import { Badge, cn } from '@/components/ui';

/** 等级徽标：Lv.3 成篇。 */
export function LevelBadge({ level, className }: { level: Level; className?: string }) {
  return (
    <Badge tone="amber" className={cn('font-serif', className)}>
      Lv.{level.level} {level.title}
    </Badge>
  );
}
