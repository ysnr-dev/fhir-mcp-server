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
 * ProxyOAuthServerProvider adapted to Auth0.
 *
 * **1. Hands out one pre-registered first-party client (when configured).**
 * Auth0 marks every client created through Dynamic Client Registration as
 * third-party, and then refuses such a client *both* audiences it could ask for:
 * the implicit `/userinfo` one (`The userinfo audience is not allowed for third
 * party clients`) and any custom API (`Client ... is not authorized to access
 * resource server ...`). No audience is left, so the flow dies right after a
 * successful login. A first-party application created in the Auth0 dashboard has
 * neither restriction, so `/register` answers with that fixed client instead of
 * forwarding registration upstream. This also stops MCP clients from creating a
 * new Auth0 application on every connection attempt — enough of them will hit the
 * tenant's entity limit and break registration outright.
 *
 * `getClient` is then a pure function of config, so a restarted instance still
 * recognises a client_id an MCP client stored earlier.
 *
 * **2. Falls back to caching DCR results** when no fixed client is configured,
 * for IdPs that do allow it. The base provider forwards `/register` upstream but
 * keeps no record, so the subsequent `/authorize` has no `redirect_uris` to
 * validate against and is rejected. That cache is per-instance and lost on
 * restart.
 *
 * **3. Drops the RFC 8707 `resource` indicator and sets `audience` instead.**
 * MCP clients send `resource=<this server's /mcp URL>`; Auth0 resolves it as an
 * API identifier and fails the authorization with
 * `access_denied: Service not found: <url>`. Auth0 expects the non-standard
 * `audience` parameter for the same purpose, so the indicator is replaced by the
 * configured audience whenever a fixed client makes a custom API reachable.
 */
class Auth0ProxyOAuthProvider extends ProxyOAuthServerProvider {
  private readonly dcrClients = new Map<string, OAuthClientInformationFull>();
  private readonly staticClient?: OAuthClientInformationFull;
  private readonly audience?: string;

  constructor(oauth: OAuthConfig) {
    super({
      endpoints: {
        authorizationUrl: oauth.authorizationUrl,
        tokenUrl: oauth.tokenUrl,
        registrationUrl: oauth.registrationUrl,
      },
      verifyAccessToken: createTokenVerifier(oauth),
      // Unknown until registered; the stores below supply real clients.
      getClient: async () => undefined,
    });

    if (oauth.client) {
      this.staticClient = {
        client_id: oauth.client.clientId,
        client_secret: oauth.client.clientSecret,
        redirect_uris: oauth.client.redirectUris,
      };
      // Only a first-party client may request a custom API audience.
      this.audience = oauth.audience;
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const staticClient = this.staticClient;
    if (staticClient) {
      return {
        getClient: async (clientId) =>
          clientId === staticClient.client_id ? staticClient : undefined,
        // Answer DCR locally: nothing is created at the IdP.
        registerClient: async () => staticClient,
      };
    }

    const baseRegister = super.clientsStore.registerClient;
    return {
      getClient: async (clientId) => this.dcrClients.get(clientId),
      registerClient: baseRegister
        ? async (client) => {
            const registered = await baseRegister(client);
            this.dcrClients.set(registered.client_id, registered);
            return registered;
          }
        : undefined,
    };
  }

  /**
   * Rebuilds the upstream authorization URL. `params.resource` is deliberately
   * dropped; see the class doc.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const target = new URL(this._endpoints.authorizationUrl);
    const search = new URLSearchParams({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
    if (params.state) search.set("state", params.state);
    if (params.scopes?.length) search.set("scope", params.scopes.join(" "));
    if (this.audience) search.set("audience", this.audience);
    target.search = search.toString();
    res.redirect(target.toString());
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
  return new Auth0ProxyOAuthProvider(oauth);
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
 * Two token shapes are accepted, because Auth0 issues different tokens depending
 * on whether an `audience` was requested:
 *
 * - **JWT**, verified locally against the IdP's JWKS. This is the normal path:
 *   both the interactive login (a fixed first-party client passing `audience`,
 *   see `Auth0ProxyOAuthProvider`) and the Machine-to-Machine
 *   `client_credentials` flow used by `scripts/verify-oauth.sh` produce one.
 * - **Opaque access token**, validated by calling the IdP's `/userinfo`
 *   endpoint. Reached when no audience is in play — e.g. an IdP that issues
 *   opaque tokens, or a deployment left on Dynamic Client Registration.
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
