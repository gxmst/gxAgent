import { expect, it } from 'vitest';
import { workbenchLayout } from './workbenchLayout';

it('reserves usable conversation width for side-by-side panels', () => {
  for (const width of [801, 900, 1024, 1180, 1280, 1440, 1920]) {
    for (const sidebar of [180, 280, 400]) {
      const layout = workbenchLayout(width, sidebar, 900, true, true);
      const navigation = width >= 1180 ? layout.sidebarWidth + 5 : 0;
      expect(width - navigation - layout.reviewWidth - 5).toBeGreaterThanOrEqual(360);
      expect(layout.reviewWidth).toBeGreaterThanOrEqual(320);
    }
  }
});

it('restores preferred widths after a narrow viewport without changing preferences', () => {
  const original = workbenchLayout(1920, 360, 820, true, true);
  expect(workbenchLayout(390, 360, 820, true, true).reviewWidth).toBe(390);
  expect(workbenchLayout(1180, 360, 820, true, true).reviewWidth).toBeLessThan(820);
  expect(workbenchLayout(1920, 360, 820, true, true)).toEqual(original);
});
