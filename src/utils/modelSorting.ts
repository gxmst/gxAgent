import type { ApiProfile, ModelInfo } from "../types";

const collatorFor = (locale?: string) => new Intl.Collator(locale || undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Sort provider models the way users read them, while keeping ties stable. */
export const sortModels = (models: ModelInfo[], locale?: string) => {
  const collator = collatorFor(locale);
  return [...models].sort((left, right) => (
    collator.compare(left.id, right.id)
    || collator.compare(left.owned_by || "", right.owned_by || "")
  ));
};
/** Sort profile entries by their visible name, then by id/model for ties. */
export const sortProfileEntries = (
  entries: Array<[string, ApiProfile]>,
  locale?: string,
) => {
  const collator = collatorFor(locale);
  return [...entries].sort(([leftId, left], [rightId, right]) => (
    collator.compare(left.name || leftId, right.name || rightId)
    || collator.compare(left.default_model, right.default_model)
    || collator.compare(leftId, rightId)
  ));
};
