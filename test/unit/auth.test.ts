import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { buildAuthRouterOptions, buildOAuthProvider } from "../../src/auth.js";
import type { HttpConfig, OAuthConfig } from "../../src/config.js";

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

describe("buildAuthRouterOptions", () => {
  const http: HttpConfig = {
    port: 8080,
    publicUrl: "https://fhir-mcp.example.com",
    oauth: OAUTH,
  };

  // The router publishes issuerUrl as `authorization_servers` in the
  // protected-resource metadata. Naming the IdP there makes clients drive the
  // IdP directly and bypass this proxy — discovery still succeeds, so the
  // breakage only surfaces later at the IdP.
  it("advertises this server as the authorization server, not the IdP", () => {
    const options = buildAuthRouterOptions(http);
    expect(options.issuerUrl.href).toBe("https://fhir-mcp.example.com/");
    expect(options.issuerUrl.href).not.toContain("idp.example.com");
    expect(options.baseUrl?.href).toBe("https://fhir-mcp.example.com/");
    expect(options.resourceServerUrl?.href).toBe("https://fhir-mcp.example.com/mcp");
  });
});

describe("Auth0ProxyOAuthProvider with a fixed first-party client", () => {
  const STATIC = {
    ...OAUTH,
    client: {
      clientId: "fixed_client",
      clientSecret: "s3cret",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    },
  };

  // Auth0 refuses a DCR (third-party) client both the implicit /userinfo
  // audience and any custom API, leaving nothing it can ask for. Only a
  // first-party client may name the API, so the audience rides along with it.
  it("sends the configured audience to authorize", async () => {
    const provider = buildOAuthProvider(STATIC);
    const { res, url } = redirectSpy();

    await provider.authorize(
      { client_id: "fixed_client", redirect_uris: STATIC.client.redirectUris },
      {
        redirectUri: STATIC.client.redirectUris[0],
        codeChallenge: "challenge",
        scopes: ["openid", "profile"],
        resource: new URL("https://fhir-mcp.example.com/mcp"),
      },
      res,
    );

    const target = new URL(url());
    expect(target.searchParams.get("audience")).toBe("https://fhir-mcp.example.com/api");
    expect(target.searchParams.get("resource")).toBeNull();
  });

  it("answers registration with the fixed client instead of calling the IdP", async () => {
    const provider = buildOAuthProvider(STATIC);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      const registered = await provider.clientsStore.registerClient?.(CLIENT);
      expect(registered).toMatchObject({ client_id: "fixed_client", client_secret: "s3cret" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  // RFC 7591 requires client_secret_expires_at alongside an issued secret, and
  // defaults an omitted token_endpoint_auth_method to client_secret_basic — which
  // the SDK's client authentication cannot read, since it only parses the request
  // body. Either omission breaks the token exchange after a successful login.
  it("returns the registration metadata clients need to authenticate", async () => {
    const provider = buildOAuthProvider(STATIC);
    const registered = await provider.clientsStore.registerClient?.(CLIENT);

    expect(registered?.client_secret_expires_at).toBe(0);
    expect(registered?.token_endpoint_auth_method).toBe("client_secret_post");
    expect(registered?.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(registered?.response_types).toEqual(["code"]);
  });

  // Resolving purely from config is what lets a restarted instance still
  // recognise a client_id an MCP client stored earlier.
  it("resolves the fixed client without any prior registration", async () => {
    const provider = buildOAuthProvider(STATIC);
    expect(await provider.clientsStore.getClient("fixed_client")).toMatchObject({
      client_id: "fixed_client",
    });
    expect(await provider.clientsStore.getClient("someone_else")).toBeUndefined();
  });
});

describe("Auth0ProxyOAuthProvider falling back to DCR", () => {
  // Auth0 resolves `resource` as an API identifier and fails the whole
  // authorization with `access_denied: Service not found` when no such API
  // exists, so the indicator must never reach the IdP.
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
    // Without a first-party client there is no audience the IdP would accept.
    expect(target.searchParams.get("audience")).toBeNull();
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
