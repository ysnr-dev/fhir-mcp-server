import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { FhirClient } from "../fhir-client.js";
import { clampCount, summarizeBundle } from "../format.js";
import { assertResourceId, assertResourceType, jsonResult, run } from "./helpers.js";

export function registerHistoryTool(server: McpServer, client: FhirClient, config: Config): void {
  server.registerTool(
    "get_history",
    {
      title: "Get resource history",
      description:
        "Fetch version history. With resourceType and id: history of one resource " +
        "(GET /{type}/{id}/_history). With only resourceType: history across that type. " +
        "With neither: system-wide history.",
      inputSchema: {
        resourceType: z
          .string()
          .optional()
          .describe("FHIR resource type (omit for system-level history)"),
        id: z.string().optional().describe("Logical id (requires resourceType)"),
        since: z
          .string()
          .optional()
          .describe("Only versions created after this instant (ISO 8601)"),
        count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Entries per page (default 20, capped at ${config.maxCount})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resourceType, id, since, count }) =>
      run(async () => {
        if (id && !resourceType) {
          throw new Error("id requires resourceType to be set as well");
        }
        let path = "/_history";
        if (resourceType) {
          assertResourceType(resourceType);
          if (id) {
            assertResourceId(id);
            path = `/${resourceType}/${id}/_history`;
          } else {
            path = `/${resourceType}/_history`;
          }
        }
        const bundle = await client.request("GET", path, {
          query: { _since: since, _count: clampCount(count, config.maxCount) },
        });
        return jsonResult(summarizeBundle(bundle));
      }),
  );
}
