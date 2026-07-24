import { describe, expect, it } from "vitest";
import { loadHttpConfig } from "../../src/config.js";

const REQUIRED = {
  PUBLIC_URL: "https://fhir-mcp.example.com",
  OAUTH_ISSUER_URL: "https://idp.example.com/",
  OAUTH_AUTHORIZATION_URL: "https://idp.example.com/authorize",
  OAUTH_TOKEN_URL: "https://idp.example.com/oauth/token",
  OAUTH_JWKS_URL: "https://idp.example.com/.well-known/jwks.json",
  OAUTH_AUDIENCE: "https://fhir-mcp.example.com/api",
};

describe("loadHttpConfig", () => {
  it("loads required settings and applies the default port", () => {
    const config = loadHttpConfig(REQUIRED);
    expect(config.port).toBe(8080);
    expect(config.publicUrl).toBe("https://fhir-mcp.example.com");
    expect(config.oauth).toEqual({
      issuerUrl: "https://idp.example.com/",
      authorizationUrl: "https://idp.example.com/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      registrationUrl: undefined,
      jwksUrl: "https://idp.example.com/.well-known/jwks.json",
      audience: "https://fhir-mcp.example.com/api",
    });
  });

  it("strips trailing slashes from the public URL", () => {
    expect(loadHttpConfig({ ...REQUIRED, PUBLIC_URL: "https://x.example.com/" }).publicUrl).toBe(
      "https://x.example.com",
    );
  });

  it("parses a custom port and optional registration URL", () => {
    const config = loadHttpConfig({
      ...REQUIRED,
      HTTP_PORT: "3333",
      OAUTH_REGISTRATION_URL: "https://idp.example.com/register",
    });
    expect(config.port).toBe(3333);
    expect(config.oauth.registrationUrl).toBe("https://idp.example.com/register");
  });

  it("rejects an invalid port", () => {
    expect(() => loadHttpConfig({ ...REQUIRED, HTTP_PORT: "0" })).toThrow(/HTTP_PORT/);
    expect(() => loadHttpConfig({ ...REQUIRED, HTTP_PORT: "nope" })).toThrow(/HTTP_PORT/);
  });

  it("rejects an invalid public URL", () => {
    expect(() => loadHttpConfig({ ...REQUIRED, PUBLIC_URL: "not a url" })).toThrow(/PUBLIC_URL/);
  });

  it("requires each OAuth setting", () => {
    for (const key of Object.keys(REQUIRED)) {
      const partial = { ...REQUIRED } as Record<string, string | undefined>;
      delete partial[key];
      expect(() => loadHttpConfig(partial), `missing ${key}`).toThrow(new RegExp(key));
    }
  });
});
