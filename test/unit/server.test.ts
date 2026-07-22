import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import type { FetchLike } from "../../src/token-manager.js";

const BASE_CONFIG: Config = {
  baseUrl: "http://fhir.example",
  allowWrites: false,
  maxCount: 50,
};

async function connect(config: Config, fetchFn: FetchLike) {
  const server = buildServer(config, fetchFn);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function fhirResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/fhir+json" },
  });
}

const READ_TOOLS = [
  "get_capabilities",
  "search_fhir",
  "read_fhir",
  "patient_everything",
  "get_history",
  "validate_fhir",
];
const WRITE_TOOLS = ["create_fhir", "update_fhir", "patch_fhir"];

describe("buildServer", () => {
  it("registers only read tools by default", async () => {
    const client = await connect(BASE_CONFIG, vi.fn());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it("registers write tools when allowWrites is true", async () => {
    const client = await connect({ ...BASE_CONFIG, allowWrites: true }, vi.fn());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(names).toContain(name);
    }
  });

  it("search_fhir clamps _count and returns a flattened bundle", async () => {
    const fetchFn = vi.fn(async () =>
      fhirResponse(200, {
        resourceType: "Bundle",
        total: 1,
        entry: [{ resource: { resourceType: "Patient", id: "p1" } }],
      }),
    );
    const client = await connect({ ...BASE_CONFIG, maxCount: 30 }, fetchFn);

    const result = await client.callTool({
      name: "search_fhir",
      arguments: { resourceType: "Patient", params: { name: "山田" }, count: 999 },
    });

    const [url] = fetchFn.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/Patient");
    expect(parsed.searchParams.get("name")).toBe("山田");
    expect(parsed.searchParams.get("_count")).toBe("30");

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const summary = JSON.parse(text);
    expect(summary.total).toBe(1);
    expect(summary.resources).toEqual([{ resourceType: "Patient", id: "p1" }]);
  });

  it("rejects a path-breaking resourceType as a tool error", async () => {
    const fetchFn = vi.fn();
    const client = await connect(BASE_CONFIG, fetchFn);
    const result = await client.callTool({
      name: "read_fhir",
      arguments: { resourceType: "Patient/../admin", id: "p1" },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns FHIR errors as tool errors with readable messages", async () => {
    const fetchFn = vi.fn(async () =>
      fhirResponse(404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "Patient p9 not found" }],
      }),
    );
    const client = await connect(BASE_CONFIG, fetchFn);
    const result = await client.callTool({
      name: "read_fhir",
      arguments: { resourceType: "Patient", id: "p9" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Patient p9 not found");
  });

  it("validate_fhir reports validity from OperationOutcome issues", async () => {
    const fetchFn = vi.fn(async () =>
      fhirResponse(200, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "warning", code: "informational", diagnostics: "minor issue" }],
      }),
    );
    const client = await connect(BASE_CONFIG, fetchFn);
    const result = await client.callTool({
      name: "validate_fhir",
      arguments: { resource: { resourceType: "Patient", name: [{ family: "山田" }] } },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual(["[warning] informational: minor issue"]);
  });
});
