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
