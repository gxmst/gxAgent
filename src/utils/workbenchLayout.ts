const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function workbenchLayout(viewport: number, sidebar: number, review: number, navigationOpen: boolean, reviewOpen: boolean) {
  const desktop = viewport >= 1180;
  const split = viewport > 800;
  const sidebarPreference = clamp(sidebar, 180, 400);
  const navigationSpace = desktop && navigationOpen ? sidebarPreference + 5 : 0;
  const maxReviewWidth = clamp(viewport - navigationSpace - 5 - 360, 320, 900);
  const reviewWidth = split ? clamp(review, 320, maxReviewWidth) : viewport;
  const maxSidebarWidth = clamp(viewport - (reviewOpen && desktop ? reviewWidth + 5 : 0) - 5 - 360, 180, 400);
  return {
    sidebarWidth: clamp(sidebarPreference, 180, maxSidebarWidth),
    reviewWidth,
    maxSidebarWidth,
    maxReviewWidth,
  };
}
