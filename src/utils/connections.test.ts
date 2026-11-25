import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../appDefaults";
import { connectionError, connectionModels, profileFromPreset } from "./connections";

describe("connection isolation", () => {
  it("never copies the previous credential to a provider preset", () => {
    expect(profileFromPreset({ name: "Gateway", provider: "openai", wire_format: "openai", base_url: "https://example.com/v1", default_model: "private", needs_api_key: true }).api_key).toBe("");
  });
  it("preserves a private model when the directory omits it", () => {
    expect(connectionModels("private", ["private", "saved"], [{ id: "listed" }]).map(m => m.id)).toEqual(["private", "saved", "listed"]);
  });
  it("rejects duplicates but permits renaming the same stable connection", () => {
    const profile = { name: "Office", base_url: "https://example.com/v1", api_key: "", default_model: "m", wire_format: "openai", provider: "openai" };
    const profiles = { "legacy-name": profile };
    expect(connectionError(profile, profiles, null, false)).toContain("already exists");
    expect(connectionError(profile, profiles, "legacy-name", false)).toBe("");
    expect(connectionError({ ...profile, base_url: "file:///x" }, DEFAULT_CONFIG.profiles, null, false)).toContain("HTTP(S)");
  });
});
