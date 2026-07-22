import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { FhirClient } from "../fhir-client.js";
import { clampCount, summarizeBundle } from "../format.js";
import { assertResourceType, jsonResult, run } from "./helpers.js";

export function registerSearchTool(server: McpServer, client: FhirClient, config: Config): void {
  server.registerTool(
    "search_fhir",
    {
      title: "Search FHIR resources",
      description:
        "Search resources of a given type (GET /{resourceType}?...). Search parameters are passed " +
        "through to the server as-is, so chained parameters, _has, _include, _revinclude, _sort, " +
        "_total etc. all work. To keep responses small, prefer _elements (comma-separated field " +
        "list) or _summary=true, and page with _count plus the returned hasNextPage flag " +
        "(use params like _count/_offset or the server's paging links).",
      inputSchema: {
        resourceType: z
          .string()
          .describe("FHIR resource type to search, e.g. Patient, Observation, Condition"),
        params: z
          .record(z.string())
          .optional()
          .describe(
            'Search parameters as key-value pairs, e.g. {"name": "山田", "_elements": "id,name,birthDate"}. ' +
              "Repeat-style OR values can be comma-separated per FHIR search rules.",
          ),
        count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Results per page (default 20, capped at ${config.maxCount})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resourceType, params, count }) =>
      run(async () => {
        assertResourceType(resourceType);
        const query: Record<string, string> = { ...(params ?? {}) };
        query._count = String(clampCount(count, config.maxCount));
        const bundle = await client.request("GET", `/${resourceType}`, { query });
        return jsonResult(summarizeBundle(bundle));
      }),
  );
}
