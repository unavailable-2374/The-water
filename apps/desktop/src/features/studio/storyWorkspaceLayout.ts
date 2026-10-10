/** Fit the map to its actual pane, rather than to the application window. */
export function storyMapLayout(count: number, paneWidth: number) {
  const width = Math.max(0, paneWidth);
  const gap = Math.min(16, width / 8);
  const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / 240)));
  const cardWidth = Math.max(0, (width - gap * (columns + 1)) / columns);
  const cardHeight = 124;
  const rowHeight = cardHeight + 40;
  return {
    width,
    columns,
    cardWidth,
    cardHeight,
    height: Math.max(rowHeight, Math.ceil(count / columns) * rowHeight),
    point: (index: number) => ({
      x: gap + (index % columns) * (cardWidth + gap),
      y: 12 + Math.floor(index / columns) * rowHeight,
    }),
  };
}

export function storyWorkspacePanels(width: number, split: boolean) {
  return {
    navigationInline: !split && width >= 1000,
    inspectorInline: width >= (split ? 1200 : 1000),
    splitColumns: width - (split && width >= 1200 ? 320 : 0) >= 620,
  };
}
