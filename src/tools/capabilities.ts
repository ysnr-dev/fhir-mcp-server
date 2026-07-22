import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FhirClient } from "../fhir-client.js";
import { summarizeCapabilities } from "../format.js";
import { jsonResult, run } from "./helpers.js";

export function registerCapabilitiesTool(server: McpServer, client: FhirClient): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get FHIR server capabilities",
      description:
        "Fetch the FHIR server's CapabilityStatement (GET /metadata) and return a compact summary: " +
        "supported resource types, interactions, search parameters, and operations. " +
        "Call this first to discover what the server supports.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const statement = await client.request("GET", "/metadata");
        return jsonResult(summarizeCapabilities(statement));
      }),
  );
}
