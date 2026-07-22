/**
 * End-to-end tests against a real fhir-server.
 *
 * Skipped unless FHIR_INTEGRATION_BASE_URL is set, e.g.:
 *   FHIR_INTEGRATION_BASE_URL=http://localhost:3000 npm test
 * Optionally set FHIR_INTEGRATION_CLIENT_ID / FHIR_INTEGRATION_CLIENT_SECRET
 * to exercise the SMART client_credentials path.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const baseUrl = process.env.FHIR_INTEGRATION_BASE_URL;

describe.skipIf(!baseUrl)("integration: fhir-server", () => {
  async function connect() {
    const server = buildServer({
      baseUrl: baseUrl as string,
      clientId: process.env.FHIR_INTEGRATION_CLIENT_ID,
      clientSecret: process.env.FHIR_INTEGRATION_CLIENT_SECRET,
      allowWrites: false,
      maxCount: 50,
    });
    const client = new Client({ name: "integration-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  function firstText(result: { content?: unknown }): string {
    return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  }

  it("fetches capabilities", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    expect(result.isError).toBeFalsy();
    const summary = JSON.parse(firstText(result));
    expect(summary.fhirVersion).toBeTruthy();
    expect(Array.isArray(summary.resources)).toBe(true);
  });

  it("searches then reads a Patient", async () => {
    const client = await connect();
    const search = await client.callTool({
      name: "search_fhir",
      arguments: { resourceType: "Patient", count: 1 },
    });
    expect(search.isError).toBeFalsy();
    const summary = JSON.parse(firstText(search));
    if (summary.resources.length === 0) return; // empty server — nothing further to assert

    const { id } = summary.resources[0];
    const read = await client.callTool({
      name: "read_fhir",
      arguments: { resourceType: "Patient", id },
    });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(firstText(read)).id).toBe(id);
  });

  it("validates a minimal Patient", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "validate_fhir",
      arguments: { resource: { resourceType: "Patient", name: [{ family: "テスト" }] } },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toHaveProperty("valid");
  });
});
