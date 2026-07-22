import type { FetchLike, TokenManager } from "./token-manager.js";

export type QueryValue = string | number | boolean | string[] | undefined;

export interface FhirRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface OperationOutcomeIssue {
  severity?: string;
  code?: string;
  diagnostics?: string;
  details?: { text?: string };
  expression?: string[];
}

export class FhirError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: OperationOutcomeIssue[] = [],
  ) {
    super(message);
    this.name = "FhirError";
  }
}

/** Render an OperationOutcome's issues as human-readable lines. */
export function formatOperationOutcome(outcome: unknown): string[] {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    (outcome as { resourceType?: string }).resourceType !== "OperationOutcome"
  ) {
    return [];
  }
  const issues = (outcome as { issue?: OperationOutcomeIssue[] }).issue ?? [];
  return issues.map((issue) => {
    const text = issue.diagnostics ?? issue.details?.text ?? "(no details)";
    const location = issue.expression?.length ? ` (at ${issue.expression.join(", ")})` : "";
    return `[${issue.severity ?? "unknown"}] ${issue.code ?? "unknown"}: ${text}${location}`;
  });
}

/**
 * Thin FHIR REST client: builds URLs, attaches Bearer tokens, retries once on
 * 401, and converts error responses (OperationOutcome) into FhirError.
 */
export class FhirClient {
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenManager,
    fetchFn?: FetchLike,
  ) {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  async request(method: string, path: string, options: FhirRequestOptions = {}): Promise<unknown> {
    const url = this.buildUrl(path, options.query);

    let response = await this.send(method, url, options);
    if (response.status === 401 && this.tokens.enabled) {
      this.tokens.invalidate();
      response = await this.send(method, url, options);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const issues = formatOperationOutcome(parsed);
      const detail = issues.length
        ? issues.join("\n")
        : text.slice(0, 500) || "(empty response body)";
      throw new FhirError(
        `FHIR request failed: ${method} ${path} → HTTP ${response.status}\n${detail}`,
        response.status,
        typeof parsed === "object" && parsed !== null
          ? ((parsed as { issue?: OperationOutcomeIssue[] }).issue ?? [])
          : [],
      );
    }

    return parsed;
  }

  private async send(method: string, url: string, options: FhirRequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/fhir+json",
      ...options.headers,
    };
    const token = await this.tokens.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] ??= "application/fhir+json";
    }

    return this.fetchFn(url, { method, headers, body });
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        url.searchParams.append(key, String(v));
      }
    }
    return url.toString();
  }
}
