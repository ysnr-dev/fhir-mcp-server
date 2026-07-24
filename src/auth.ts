import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthConfig } from "./config.js";

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
  const verifyAccessToken = createTokenVerifier(oauth);

  return new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      registrationUrl: oauth.registrationUrl,
    },
    verifyAccessToken,
    // The IdP is the source of truth for registered clients; with Dynamic
    // Client Registration enabled, the Claude app registers itself upstream.
    getClient: async (clientId) => ({
      client_id: clientId,
      redirect_uris: [],
    }),
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
