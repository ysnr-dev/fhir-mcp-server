import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthRouterOptions } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HttpConfig, OAuthConfig } from "./config.js";

/**
 * ProxyOAuthServerProvider adapted to Auth0 in two ways.
 *
 * **1. Remembers clients registered via Dynamic Client Registration.**
 * The base proxy provider forwards `/register` to the IdP but keeps no record of
 * the result, so on the subsequent `/authorize` the router's `getClient` lookup
 * has no `redirect_uris` to validate against and rejects the request. We cache
 * each DCR result in memory (registration → authorize happens within seconds of
 * a single connect), and fall back to "unknown client" for cache misses.
 *
 * Note (demo constraint): the cache is per-instance and lost on restart. On a
 * Render Free instance that has slept, a client re-authorizing with a cached
 * client_id may need to re-register. Access-token verification is stateless
 * and unaffected.
 *
 * **2. Drops the RFC 8707 `resource` indicator.**
 * MCP clients send `resource=<this server's /mcp URL>`, and the base provider
 * forwards it to the IdP. Auth0 resolves `resource` as an API (Resource Server)
 * identifier and fails the whole authorization with
 * `access_denied: Service not found: <url>` when no such API exists. Registering
 * that API would not help either: Auth0 refuses to issue custom-API tokens to
 * third-party (DCR) clients — the very reason this deployment relies on opaque
 * user tokens verified via `/userinfo` (see `createTokenVerifier`). Since the
 * token is deliberately not audience-bound, the indicator carries no meaning
 * upstream and is stripped from authorize and both token exchanges.
 */
class CachingProxyOAuthProvider extends ProxyOAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  get clientsStore(): OAuthRegisteredClientsStore {
    const baseRegister = super.clientsStore.registerClient;
    return {
      getClient: async (clientId) => this.clients.get(clientId),
      registerClient: baseRegister
        ? async (client) => {
            const registered = await baseRegister(client);
            this.clients.set(registered.client_id, registered);
            return registered;
          }
        : undefined,
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const { resource: _resource, ...rest } = params;
    return super.authorize(client, rest, res);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    return super.exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    return super.exchangeRefreshToken(client, refreshToken, scopes);
  }
}

/**
 * Builds an OAuth provider that delegates the authorization/token flow to an
 * external IdP and verifies the resulting access tokens locally via JWKS.
 *
 * Scope of this build (demo data): OAuth only gates who may connect to the MCP
 * server. It does NOT map the authenticated user to a FHIR access range — that
 * per-user PHI control is deferred to the production phase. FHIR calls continue
 * to use the fixed SMART Backend Services credentials.
 */
export function buildOAuthProvider(oauth: OAuthConfig): ProxyOAuthServerProvider {
  return new CachingProxyOAuthProvider({
    endpoints: {
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      registrationUrl: oauth.registrationUrl,
    },
    verifyAccessToken: createTokenVerifier(oauth),
    // Unknown until registered; the cached store above supplies real clients.
    getClient: async () => undefined,
  });
}

/**
 * Metadata settings for `mcpAuthRouter`, minus the provider.
 *
 * `issuerUrl` is deliberately **this server**, not the IdP. The router publishes
 * it as `authorization_servers` in the protected-resource metadata, so naming the
 * IdP there makes clients fetch the IdP's own metadata and drive the IdP
 * directly — bypassing this proxy and every upstream quirk it absorbs (Auth0
 * rejecting the RFC 8707 `resource` indicator, DCR results going uncached).
 * The failure is silent: discovery still succeeds and the flow only breaks later,
 * at the IdP.
 */
export function buildAuthRouterOptions(http: HttpConfig): Omit<AuthRouterOptions, "provider"> {
  return {
    issuerUrl: new URL(http.publicUrl),
    baseUrl: new URL(http.publicUrl),
    resourceServerUrl: new URL(`${http.publicUrl}/mcp`),
    scopesSupported: ["openid", "profile"],
    resourceName: "fhir-mcp-server",
  };
}

/**
 * Verifies an IdP access token and returns the AuthInfo the SDK attaches to the
 * request.
 *
 * Two token shapes are accepted, because Auth0 issues different tokens to
 * different clients:
 *
 * - **Opaque user access token** (the interactive DCR / mobile flow). Auth0
 *   forbids third-party (DCR) clients from obtaining custom-API JWTs, so the
 *   tenant must NOT set a Default Audience; the token is then opaque and is
 *   validated by calling the IdP's `/userinfo` endpoint.
 * - **JWT** (the Machine-to-Machine `client_credentials` flow, which passes an
 *   explicit `audience`). Verified locally against the IdP's JWKS. Kept so the
 *   verification tooling (`scripts/verify-oauth.sh`) keeps working.
 */
export function createTokenVerifier(oauth: OAuthConfig): (token: string) => Promise<AuthInfo> {
  const jwks = createRemoteJWKSet(new URL(oauth.jwksUrl));
  const userinfoUrl = new URL("/userinfo", oauth.issuerUrl).toString();

  return async (token: string): Promise<AuthInfo> => {
    // A three-segment token is a JWT (M2M). Verify it locally; on any failure
    // fall through to /userinfo, since opaque tokens also can't be parsed here.
    if (token.split(".").length === 3) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: oauth.issuerUrl,
          audience: oauth.audience,
        });
        const scopes =
          typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
        return {
          token,
          clientId: typeof payload.azp === "string" ? payload.azp : (payload.sub ?? ""),
          scopes,
          expiresAt: payload.exp,
          extra: { sub: payload.sub },
        };
      } catch {
        // Not a JWT we can verify; treat as opaque below.
      }
    }

    // Opaque user access token: valid iff /userinfo accepts it.
    const response = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Access token rejected by userinfo (HTTP ${response.status})`);
    }
    const profile = (await response.json()) as { sub?: string };
    return {
      token,
      clientId: profile.sub ?? "",
      scopes: [],
      extra: { sub: profile.sub },
    };
  };
}
