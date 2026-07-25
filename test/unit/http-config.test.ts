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

  it("loads the fixed first-party client when all three settings are present", () => {
    const config = loadHttpConfig({
      ...REQUIRED,
      OAUTH_CLIENT_ID: "abc",
      OAUTH_CLIENT_SECRET: "s3cret",
      OAUTH_CLIENT_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback, https://x.test/cb",
    });
    expect(config.oauth.client).toEqual({
      clientId: "abc",
      clientSecret: "s3cret",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback", "https://x.test/cb"],
    });
  });

  it("falls back to DCR when no fixed client is configured", () => {
    expect(loadHttpConfig(REQUIRED).oauth.client).toBeUndefined();
  });

  // A half-configured client would silently fall back to DCR, which Auth0
  // rejects only after a successful login — fail loudly at startup instead.
  it("rejects a partially configured fixed client", () => {
    expect(() => loadHttpConfig({ ...REQUIRED, OAUTH_CLIENT_ID: "abc" })).toThrow(
      /must be set together/,
    );
    expect(() =>
      loadHttpConfig({ ...REQUIRED, OAUTH_CLIENT_ID: "abc", OAUTH_CLIENT_SECRET: "s" }),
    ).toThrow(/must be set together/);
  });

  it("rejects an invalid redirect URI", () => {
    expect(() =>
      loadHttpConfig({
        ...REQUIRED,
        OAUTH_CLIENT_ID: "abc",
        OAUTH_CLIENT_SECRET: "s",
        OAUTH_CLIENT_REDIRECT_URIS: "not a url",
      }),
    ).toThrow(/OAUTH_CLIENT_REDIRECT_URIS/);
  });

  it("requires each OAuth setting", () => {
    for (const key of Object.keys(REQUIRED)) {
      const partial = { ...REQUIRED } as Record<string, string | undefined>;
      delete partial[key];
      expect(() => loadHttpConfig(partial), `missing ${key}`).toThrow(new RegExp(key));
    }
  });
});
