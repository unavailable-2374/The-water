/** TEST dimensions and node counts; layout geometry only. */
import { expect, it } from "vitest";
import {
  storyMapLayout,
  storyWorkspacePanels,
} from "@/features/studio/storyWorkspaceLayout";

it("TEST every map card fits its pane at narrow and wide widths without horizontal cropping", () => {
  for (const width of [160, 220, 288, 360, 472, 720, 1044]) {
    const layout = storyMapLayout(48, width);
    for (let i = 0; i < 48; i++) {
      const point = layout.point(i);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x + layout.cardWidth).toBeLessThanOrEqual(width + 0.001);
      expect(point.y + layout.cardHeight).toBeLessThanOrEqual(layout.height);
    }
  }
});

it("TEST split reading at the desktop minimum keeps side panels off the prose width", () => {
  expect(storyWorkspacePanels(724, true)).toMatchObject({
    navigationInline: false,
    inspectorInline: false,
    splitColumns: true,
  });
  expect(storyWorkspacePanels(516, true)).toMatchObject({
    navigationInline: false,
    inspectorInline: false,
    splitColumns: false,
  });
  expect(storyWorkspacePanels(1364, true).inspectorInline).toBe(true);
  expect(storyWorkspacePanels(724, false).navigationInline).toBe(false);
});
