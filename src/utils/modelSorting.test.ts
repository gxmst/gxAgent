import { describe, expect, it } from "vitest";
import type { ApiProfile } from "../types";
import { sortModels, sortProfileEntries } from "./modelSorting";

describe("model sorting", () => {
  it("sorts model ids naturally and case-insensitively", () => {
    const models = ["model-10", "Model-2", "alpha"].map((id) => ({ id }));
    expect(sortModels(models).map((model) => model.id)).toEqual(["alpha", "Model-2", "model-10"]);
  });

  it("sorts profiles by visible name with deterministic tie breakers", () => {
    const profile = (name: string, default_model: string): ApiProfile => ({
      name,
      default_model,
      base_url: "https://example.test",
      api_key: "",
      wire_format: "openai",
      provider: "openai",
    });
    const profiles: Array<[string, ApiProfile]> = [
      ["z", profile("Beta", "m-2")],
      ["a", profile("alpha", "m-10")],
      ["b", profile("alpha", "m-2")],
    ];
    expect(sortProfileEntries(profiles).map(([id]) => id)).toEqual(["b", "a", "z"]);
  });
});
