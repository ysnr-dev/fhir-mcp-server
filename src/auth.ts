import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthConfig } from "./config.js";

/**
 * ProxyOAuthServerProvider whose client store remembers clients registered via
 * Dynamic Client Registration.
 *
 * The base proxy provider forwards `/register` to the IdP but keeps no record of
 * the result, so on the subsequent `/authorize` the router's `getClient` lookup
 * has no `redirect_uris` to validate against and rejects the request. We cache
 * each DCR result in memory (registration → authorize happens within seconds of
 * a single connect), and fall back to "unknown client" for cache misses.
 *
 * Note (demo constraint): the cache is per-instance and lost on restart. On a
 * Render Free instance that has slept, a client re-authorizing with a cached
 * client_id may need to re-register. Access-token verification is stateless
 * (JWKS) and unaffected.
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
