import { describe, expect, it } from "vitest";
import {
  modelCatalogForConfig,
  modelCatalogKey,
  modelContextLimitForConfig,
} from "./appDefaults";

const connection = {
  wire_format: "openai",
  base_url: "https://models.example.test/v1/",
};
const models = [{ id: "shared-model", context_length: 32_000 }];

describe("provider model catalog provenance", () => {
  it("normalizes harmless connection formatting differences", () => {
    expect(modelCatalogKey(connection)).toBe(modelCatalogKey({
      wire_format: "OPENAI",
      base_url: "https://models.example.test/v1",
    }));
  });

  it("uses reported context limits only for the connection that supplied them", () => {
    const sourceKey = modelCatalogKey(connection);

    expect(modelContextLimitForConfig("shared-model", models, sourceKey, connection)).toBe(32_000);
    expect(modelContextLimitForConfig("shared-model", models, sourceKey, {
      wire_format: "openai",
      base_url: "https://other.example.test/v1",
    })).toBe(128_000);
  });

  it("hides a catalog from session profiles that resolve to another endpoint", () => {
    const sourceKey = modelCatalogKey(connection);

    expect(modelCatalogForConfig(models, sourceKey, connection)).toBe(models);
    expect(modelCatalogForConfig(models, sourceKey, {
      wire_format: "anthropic",
      base_url: connection.base_url,
    })).toEqual([]);
  });
});
