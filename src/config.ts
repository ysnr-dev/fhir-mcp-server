export interface Config {
  /** Base URL of the FHIR server, without trailing slash. */
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  /** Register write tools (create/update/patch) only when true. */
  allowWrites: boolean;
  /** Upper bound for the `_count` search parameter. */
  maxCount: number;
}

export const DEFAULT_SEARCH_COUNT = 20;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawBaseUrl = env.FHIR_BASE_URL ?? "http://localhost:3000";
  let baseUrl: string;
  try {
    baseUrl = new URL(rawBaseUrl).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`FHIR_BASE_URL is not a valid URL: ${rawBaseUrl}`);
  }

  const clientId = emptyToUndefined(env.FHIR_CLIENT_ID);
  const clientSecret = emptyToUndefined(env.FHIR_CLIENT_SECRET);
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "FHIR_CLIENT_ID and FHIR_CLIENT_SECRET must be set together (or both left unset for no-auth mode)",
    );
  }

  const maxCountRaw = env.FHIR_MCP_MAX_COUNT ?? "50";
  const maxCount = Number.parseInt(maxCountRaw, 10);
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    throw new Error(`FHIR_MCP_MAX_COUNT must be a positive integer: ${maxCountRaw}`);
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    allowWrites: env.FHIR_MCP_ALLOW_WRITES === "true",
    maxCount,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * HTTP / OAuth settings for the remote (Web) transport.
 *
 * Only used by the HTTP entrypoint (`src/http.ts`); the stdio entrypoint does
 * not read these, so running stdio never requires OAuth env to be present.
 */
export interface HttpConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Public HTTPS URL of this MCP server (e.g. https://fhir-mcp.example.run.app). */
  publicUrl: string;
  oauth: OAuthConfig;
}

/**
 * OAuth delegation settings. This MCP server acts as a Resource Server and
 * proxies the authorization/token endpoints to an external IdP (Auth0 等)。
 */
export interface OAuthConfig {
  /** IdP issuer URL (used as the authorization server issuer). */
  issuerUrl: string;
  /** IdP authorization endpoint. */
  authorizationUrl: string;
  /** IdP token endpoint. */
  tokenUrl: string;
  /** IdP dynamic client registration endpoint (optional). */
  registrationUrl?: string;
  /** JWKS endpoint used to verify access tokens (RS256 等). */
  jwksUrl: string;
  /** Expected `aud` claim of access tokens (this server's API identifier). */
  audience: string;
}

export const DEFAULT_HTTP_PORT = 8080;

export function loadHttpConfig(env: Record<string, string | undefined> = process.env): HttpConfig {
  // Cloud Run injects PORT; honour it as a fallback for HTTP_PORT.
  const portRaw = env.HTTP_PORT ?? env.PORT ?? String(DEFAULT_HTTP_PORT);
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HTTP_PORT must be a valid port number: ${portRaw}`);
  }

  const publicUrl = requireEnv(env, "PUBLIC_URL");
  try {
    new URL(publicUrl);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }

  const oauth: OAuthConfig = {
    issuerUrl: requireEnv(env, "OAUTH_ISSUER_URL"),
    authorizationUrl: requireEnv(env, "OAUTH_AUTHORIZATION_URL"),
    tokenUrl: requireEnv(env, "OAUTH_TOKEN_URL"),
    registrationUrl: emptyToUndefined(env.OAUTH_REGISTRATION_URL),
    jwksUrl: requireEnv(env, "OAUTH_JWKS_URL"),
    audience: requireEnv(env, "OAUTH_AUDIENCE"),
  };

  return { port, publicUrl: publicUrl.replace(/\/+$/, ""), oauth };
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = emptyToUndefined(env[name]);
  if (!value) {
    throw new Error(`${name} is required for the HTTP (Web) transport`);
  }
  return value;
}
