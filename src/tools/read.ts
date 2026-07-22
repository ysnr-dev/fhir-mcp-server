import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FhirClient } from "../fhir-client.js";
import { assertResourceId, assertResourceType, jsonResult, run } from "./helpers.js";

export function registerReadTool(server: McpServer, client: FhirClient): void {
  server.registerTool(
    "read_fhir",
    {
      title: "Read a FHIR resource",
      description: "Read a single resource by type and id (GET /{resourceType}/{id}).",
      inputSchema: {
        resourceType: z.string().describe("FHIR resource type, e.g. Patient"),
        id: z.string().describe("Logical id of the resource"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resourceType, id }) =>
      run(async () => {
        assertResourceType(resourceType);
        assertResourceId(id);
        const resource = await client.request("GET", `/${resourceType}/${id}`);
        return jsonResult(resource);
      }),
  );
}
