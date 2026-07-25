import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { buildOAuthProvider } from "../../src/auth.js";
import type { OAuthConfig } from "../../src/config.js";

const OAUTH: OAuthConfig = {
  issuerUrl: "https://idp.example.com/",
  authorizationUrl: "https://idp.example.com/authorize",
  tokenUrl: "https://idp.example.com/oauth/token",
  registrationUrl: "https://idp.example.com/oidc/register",
  jwksUrl: "https://idp.example.com/.well-known/jwks.json",
  audience: "https://fhir-mcp.example.com/api",
};

const CLIENT = {
  client_id: "tpc_abc",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
};

/** Captures the URL passed to `res.redirect`. */
function redirectSpy(): { res: Response; url: () => string } {
  let captured = "";
  const res = {
    redirect: (target: string) => {
      captured = target;
    },
  } as unknown as Response;
  return { res, url: () => captured };
}

describe("CachingProxyOAuthProvider", () => {
  // Auth0 resolves `resource` as an API identifier and fails the whole
  // authorization with `access_denied: Service not found` when no such API
  // exists. Tokens here are deliberately not audience-bound, so the indicator
  // must never reach the IdP.
  it("does not forward the RFC 8707 resource indicator to authorize", async () => {
    const provider = buildOAuthProvider(OAUTH);
    const { res, url } = redirectSpy();

    await provider.authorize(
      CLIENT,
      {
        redirectUri: CLIENT.redirect_uris[0],
        codeChallenge: "challenge",
        state: "state123",
        scopes: ["openid", "profile"],
        resource: new URL("https://fhir-mcp.example.com/mcp"),
      },
      res,
    );

    const target = new URL(url());
    expect(target.origin + target.pathname).toBe("https://idp.example.com/authorize");
    expect(target.searchParams.get("resource")).toBeNull();
    // The rest of the request must still be proxied intact.
    expect(target.searchParams.get("client_id")).toBe("tpc_abc");
    expect(target.searchParams.get("scope")).toBe("openid profile");
    expect(target.searchParams.get("state")).toBe("state123");
    expect(target.searchParams.get("code_challenge")).toBe("challenge");
  });

  it("does not forward the resource indicator on either token exchange", async () => {
    const provider = buildOAuthProvider(OAUTH);
    // A fresh Response per call — a shared one has its body consumed after the first read.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new globalThis.Response(JSON.stringify({ access_token: "tok", token_type: "Bearer" }), {
          headers: { "content-type": "application/json" },
        }),
    );

    try {
      const resource = new URL("https://fhir-mcp.example.com/mcp");
      await provider.exchangeAuthorizationCode(CLIENT, "code", "verifier", undefined, resource);
      await provider.exchangeRefreshToken(CLIENT, "refresh", ["openid"], resource);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls) {
        expect(String(init?.body)).not.toContain("resource");
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("remembers clients registered via DCR so authorize can look them up", async () => {
    const provider = buildOAuthProvider(OAUTH);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response(JSON.stringify(CLIENT), {
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      expect(await provider.clientsStore.getClient("tpc_abc")).toBeUndefined();
      await provider.clientsStore.registerClient?.(CLIENT);
      expect(await provider.clientsStore.getClient("tpc_abc")).toMatchObject({
        client_id: "tpc_abc",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
