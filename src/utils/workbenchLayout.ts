const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function workbenchLayout(viewport: number, sidebar: number, review: number, navigationOpen: boolean, reviewOpen: boolean) {
  // A third pane needs more room; a normal two-pane window can keep its sidebar.
  const navigationOverlay = viewport <= 800 || (reviewOpen && viewport < 1180);
  const desktop = !navigationOverlay;
  const split = viewport > 800;
  const sidebarPreference = clamp(sidebar, 180, 400);
  const navigationSpace = desktop && navigationOpen ? sidebarPreference + 5 : 0;
  const maxReviewWidth = clamp(viewport - navigationSpace - 5 - 360, 320, 900);
  const reviewWidth = split ? clamp(review, 320, maxReviewWidth) : viewport;
  const maxSidebarWidth = clamp(viewport - (reviewOpen && desktop ? reviewWidth + 5 : 0) - 5 - 360, 180, 400);
  return {
    navigationOverlay,
    sidebarWidth: clamp(sidebarPreference, 180, maxSidebarWidth),
    reviewWidth,
    maxSidebarWidth,
    maxReviewWidth,
  };
}
