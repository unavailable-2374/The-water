/** 选段气泡的定位：纯计算，方便单测。 */

const MARGIN = 8;

export interface PopoverBox {
  anchorX: number;
  below: number;
  above: number;
  width: number;
  height: number;
  viewportW: number;
  viewportH: number;
  margin?: number;
}

/** 纯逻辑：把气泡钳进视口，下方放不下就翻到选区上方。 */
export function clampPopover(box: PopoverBox): { left: number; top: number } {
  const m = box.margin ?? MARGIN;
  const left = Math.max(m, Math.min(box.anchorX - box.width / 2, box.viewportW - box.width - m));
  let top = box.below + m;
  if (top + box.height + m > box.viewportH) {
    const flipped = box.above - box.height - m;
    top = flipped >= m ? flipped : Math.max(m, box.viewportH - box.height - m);
  }
  return { left, top };
}
