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
 * Verifies an IdP-issued JWT access token against the IdP's JWKS, checking the
 * issuer and audience. Returns the AuthInfo the SDK attaches to the request.
 */
export function createTokenVerifier(oauth: OAuthConfig): (token: string) => Promise<AuthInfo> {
  const jwks = createRemoteJWKSet(new URL(oauth.jwksUrl));

  return async (token: string): Promise<AuthInfo> => {
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
  };
}
