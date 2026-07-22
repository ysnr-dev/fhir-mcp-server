import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../../src/token-manager.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeManager(overrides: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  let now = 0;
  const fetchFn = vi.fn(async () =>
    jsonResponse(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 }),
  );
  const manager = new TokenManager({
    tokenUrl: "http://fhir.example/oauth/token",
    clientId: "client",
    clientSecret: "secret",
    fetchFn,
    now: () => now,
    ...overrides,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  return { manager, fetchFn, advance };
}

describe("TokenManager", () => {
  it("returns null and never calls fetch in no-auth mode", async () => {
    const { manager, fetchFn } = makeManager({ clientId: undefined, clientSecret: undefined });
    expect(manager.enabled).toBe(false);
    expect(await manager.getToken()).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches a token with client_credentials and caches it", async () => {
    const { manager, fetchFn } = makeManager();
    expect(await manager.getToken()).toBe("tok-1");
    expect(await manager.getToken()).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://fhir.example/oauth/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client");
    expect(body.get("client_secret")).toBe("secret");
  });

  it("refreshes proactively after 90% of expires_in", async () => {
    const { manager, fetchFn, advance } = makeManager();
    await manager.getToken();

    advance(3600 * 0.9 * 1000 - 1);
    await manager.getToken();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    advance(2);
    await manager.getToken();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refetches after invalidate()", async () => {
    const { manager, fetchFn } = makeManager();
    await manager.getToken();
    manager.invalidate();
    await manager.getToken();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent fetches", async () => {
    const { manager, fetchFn } = makeManager();
    await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx token response without leaking the body", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: "invalid_client" }));
    const { manager } = makeManager({ fetchFn });
    await expect(manager.getToken()).rejects.toThrow(/HTTP 400/);
    await expect(manager.getToken()).rejects.not.toThrow(/invalid_client/);
  });

  it("throws when the response has no access_token", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { token_type: "Bearer" }));
    const { manager } = makeManager({ fetchFn });
    await expect(manager.getToken()).rejects.toThrow(/access_token/);
  });
});
