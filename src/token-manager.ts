export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TokenManagerOptions {
  /** Full URL of the OAuth2 token endpoint, e.g. `${baseUrl}/oauth/token`. */
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  fetchFn?: FetchLike;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_EXPIRES_IN_SECONDS = 3600;
/** Refresh proactively once this fraction of the token lifetime has elapsed. */
const REFRESH_RATIO = 0.9;

/**
 * SMART Backend Services (OAuth2 client_credentials) token manager.
 *
 * When clientId/clientSecret are not configured, runs in no-auth mode and
 * getToken() resolves to null (no Authorization header should be sent).
 */
export class TokenManager {
  private token: string | null = null;
  private refreshAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: TokenManagerOptions) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  async getToken(): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.token && this.now() < this.refreshAt) return this.token;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Drop the cached token so the next getToken() fetches a fresh one (e.g. after a 401). */
  invalidate(): void {
    this.token = null;
    this.refreshAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId ?? "",
      client_secret: this.options.clientSecret ?? "",
    });

    const response = await this.fetchFn(this.options.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // Deliberately omit the response body: it may echo request parameters.
      throw new Error(
        `Token request to ${this.options.tokenUrl} failed with HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error("Token response did not contain access_token");
    }

    const expiresIn = payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
    this.token = payload.access_token;
    this.refreshAt = this.now() + expiresIn * REFRESH_RATIO * 1000;
    return this.token;
  }
}
