import { describe, expect, it, vi } from "vitest";
import { FhirClient, FhirError, formatOperationOutcome } from "../../src/fhir-client.js";
import { TokenManager } from "../../src/token-manager.js";

function fhirResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/fhir+json" },
  });
}

const TOKEN_RESPONSE = { access_token: "tok", expires_in: 3600 };

function noAuthTokens(): TokenManager {
  return new TokenManager({ tokenUrl: "http://fhir.example/oauth/token" });
}

describe("FhirClient", () => {
  it("sends Accept header and builds query strings", async () => {
    const fetchFn = vi.fn(async () => fhirResponse(200, { resourceType: "Bundle" }));
    const client = new FhirClient("http://fhir.example", noAuthTokens(), fetchFn);

    await client.request("GET", "/Patient", {
      query: { name: "山田", _count: 20, _elements: ["id", "name"], skipped: undefined },
    });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/Patient");
    expect(parsed.searchParams.get("name")).toBe("山田");
    expect(parsed.searchParams.get("_count")).toBe("20");
    expect(parsed.searchParams.getAll("_elements")).toEqual(["id", "name"]);
    expect(parsed.searchParams.has("skipped")).toBe(false);
    expect((init.headers as Record<string, string>).Accept).toBe("application/fhir+json");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("attaches a Bearer token when auth is configured", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("/oauth/token")
        ? fhirResponse(200, TOKEN_RESPONSE)
        : fhirResponse(200, { resourceType: "Patient" }),
    );
    const tokens = new TokenManager({
      tokenUrl: "http://fhir.example/oauth/token",
      clientId: "c",
      clientSecret: "s",
      fetchFn,
    });
    const client = new FhirClient("http://fhir.example", tokens, fetchFn);

    await client.request("GET", "/Patient/p1");

    const apiCall = fetchFn.mock.calls.find(([url]) => !(url as string).includes("/oauth/token"));
    expect((apiCall?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("retries exactly once with a fresh token on 401", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if ((url as string).includes("/oauth/token")) {
        tokenCalls += 1;
        return fhirResponse(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600 });
      }
      apiCalls += 1;
      return apiCalls === 1
        ? fhirResponse(401, { resourceType: "OperationOutcome", issue: [] })
        : fhirResponse(200, { resourceType: "Patient", id: "p1" });
    });
    const tokens = new TokenManager({
      tokenUrl: "http://fhir.example/oauth/token",
      clientId: "c",
      clientSecret: "s",
      fetchFn,
    });
    const client = new FhirClient("http://fhir.example", tokens, fetchFn);

    const resource = await client.request("GET", "/Patient/p1");

    expect(resource).toMatchObject({ resourceType: "Patient", id: "p1" });
    expect(apiCalls).toBe(2);
    expect(tokenCalls).toBe(2);
    const lastApiCall = fetchFn.mock.calls.at(-1) as [string, RequestInit];
    expect((lastApiCall[1].headers as Record<string, string>).Authorization).toBe("Bearer tok-2");
  });

  it("does not retry a 401 in no-auth mode", async () => {
    const fetchFn = vi.fn(async () => fhirResponse(401, {}));
    const client = new FhirClient("http://fhir.example", noAuthTokens(), fetchFn);
    await expect(client.request("GET", "/Patient")).rejects.toThrow(FhirError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("formats OperationOutcome errors into a readable message", async () => {
    const fetchFn = vi.fn(async () =>
      fhirResponse(422, {
        resourceType: "OperationOutcome",
        issue: [
          {
            severity: "error",
            code: "required",
            diagnostics: "Patient.name is required",
            expression: ["Patient.name"],
          },
        ],
      }),
    );
    const client = new FhirClient("http://fhir.example", noAuthTokens(), fetchFn);

    const error = await client.request("POST", "/Patient", { body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(FhirError);
    expect(error.status).toBe(422);
    expect(error.message).toContain("HTTP 422");
    expect(error.message).toContain("[error] required: Patient.name is required (at Patient.name)");
  });

  it("sets Content-Type application/fhir+json for bodies by default", async () => {
    const fetchFn = vi.fn(async () => fhirResponse(201, { resourceType: "Patient" }));
    const client = new FhirClient("http://fhir.example", noAuthTokens(), fetchFn);
    await client.request("POST", "/Patient", { body: { resourceType: "Patient" } });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/fhir+json");
  });

  it("keeps an explicit Content-Type override (JSON Patch)", async () => {
    const fetchFn = vi.fn(async () => fhirResponse(200, { resourceType: "Patient" }));
    const client = new FhirClient("http://fhir.example", noAuthTokens(), fetchFn);
    await client.request("PATCH", "/Patient/p1", {
      body: [{ op: "replace", path: "/active", value: true }],
      headers: { "Content-Type": "application/json-patch+json" },
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json-patch+json",
    );
  });
});

describe("formatOperationOutcome", () => {
  it("returns empty for non-OperationOutcome values", () => {
    expect(formatOperationOutcome(null)).toEqual([]);
    expect(formatOperationOutcome({ resourceType: "Patient" })).toEqual([]);
  });

  it("falls back to details.text when diagnostics is absent", () => {
    const lines = formatOperationOutcome({
      resourceType: "OperationOutcome",
      issue: [{ severity: "warning", code: "invalid", details: { text: "odd value" } }],
    });
    expect(lines).toEqual(["[warning] invalid: odd value"]);
  });
});
