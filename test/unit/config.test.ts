import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      baseUrl: "http://localhost:3000",
      clientId: undefined,
      clientSecret: undefined,
      allowWrites: false,
      maxCount: 50,
    });
  });

  it("strips trailing slashes from the base URL", () => {
    expect(loadConfig({ FHIR_BASE_URL: "https://fhir.example/" }).baseUrl).toBe(
      "https://fhir.example",
    );
  });

  it("rejects invalid base URLs", () => {
    expect(() => loadConfig({ FHIR_BASE_URL: "not a url" })).toThrow(/FHIR_BASE_URL/);
  });

  it("requires client id and secret together", () => {
    expect(() => loadConfig({ FHIR_CLIENT_ID: "c" })).toThrow(/together/);
    expect(() => loadConfig({ FHIR_CLIENT_SECRET: "s" })).toThrow(/together/);
    expect(loadConfig({ FHIR_CLIENT_ID: "c", FHIR_CLIENT_SECRET: "s" }).clientId).toBe("c");
  });

  it("parses allowWrites and maxCount", () => {
    const config = loadConfig({ FHIR_MCP_ALLOW_WRITES: "true", FHIR_MCP_MAX_COUNT: "100" });
    expect(config.allowWrites).toBe(true);
    expect(config.maxCount).toBe(100);
  });

  it("rejects a non-numeric maxCount", () => {
    expect(() => loadConfig({ FHIR_MCP_MAX_COUNT: "lots" })).toThrow(/FHIR_MCP_MAX_COUNT/);
  });
});
