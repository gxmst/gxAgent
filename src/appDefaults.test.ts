// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  comparableWorkspacePath,
  modelCatalogForConfig,
  modelCatalogKey,
  modelContextLimitForConfig,
  normalizeTheme,
  themeMode,
} from "./appDefaults";

const connection = {
  wire_format: "openai",
  base_url: "https://models.example.test/v1/",
};
const models = [{ id: "shared-model", context_length: 32_000 }];

it("matches Git and Windows canonical drive and UNC paths while preserving POSIX case", () => {
  expect(comparableWorkspacePath("\\\\?\\C:\\Work\\Tree")).toBe(comparableWorkspacePath("c:/work/tree/"));
  expect(comparableWorkspacePath("\\\\?\\UNC\\Host\\Share")).toBe(comparableWorkspacePath("//host/share/"));
  expect(comparableWorkspacePath("/work/A")).not.toBe(comparableWorkspacePath("/work/a"));
});

describe("provider model catalog provenance", () => {
  it("isolates account-specific catalogs on the same gateway", () => {
    const first = { ...connection, api_key: "first-test-key" };
    expect(modelCatalogForConfig(models, modelCatalogKey(first), { ...connection, api_key: "other-test-key" })).toEqual([]);
  });
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

describe("theme normalization and resolution", () => {
  it("normalizes legacy and core themes into system/light/dark", () => {
    expect(normalizeTheme("system")).toBe("system");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("yuzu")).toBe("light");
    expect(normalizeTheme("ember")).toBe("dark");
    expect(normalizeTheme("grape")).toBe("dark");
    expect(normalizeTheme("amber")).toBe("dark");
    expect(normalizeTheme("unknown-theme")).toBe("light");
  });

  it("resolves themeMode for explicit and system themes", () => {
    expect(themeMode("light")).toBe("light");
    expect(themeMode("dark")).toBe("dark");
    expect(themeMode("yuzu")).toBe("light");
    expect(themeMode("ember")).toBe("dark");

    const originalMatchMedia = window.matchMedia;
    try {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
      expect(themeMode("system")).toBe("dark");
      window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
      expect(themeMode("system")).toBe("light");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
