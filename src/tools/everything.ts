import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { FhirClient } from "../fhir-client.js";
import { clampCount, summarizeBundle } from "../format.js";
import { assertResourceId, assertResourceType, jsonResult, run } from "./helpers.js";

export function registerEverythingTool(
  server: McpServer,
  client: FhirClient,
  config: Config,
): void {
  server.registerTool(
    "patient_everything",
    {
      title: "Fetch a patient's full record",
      description:
        "Fetch all resources in a patient's compartment (GET /Patient/{id}/$everything): " +
        "conditions, observations, encounters, medications, etc. Use `types` to limit resource " +
        "types and `since` to limit to recently-updated resources — both are recommended to keep " +
        "responses manageable.",
      inputSchema: {
        patientId: z.string().describe("Logical id of the Patient"),
        types: z
          .array(z.string())
          .optional()
          .describe('Restrict to these resource types, e.g. ["Observation", "Condition"]'),
        since: z
          .string()
          .optional()
          .describe(
            "Only resources updated after this instant (ISO 8601, e.g. 2026-01-01T00:00:00Z)",
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
    async ({ patientId, types, since, count }) =>
      run(async () => {
        assertResourceId(patientId);
        for (const type of types ?? []) assertResourceType(type);
        const bundle = await client.request("GET", `/Patient/${patientId}/$everything`, {
          query: {
            _type: types?.length ? types.join(",") : undefined,
            _since: since,
            _count: clampCount(count, config.maxCount),
          },
        });
        return jsonResult(summarizeBundle(bundle));
      }),
  );
}
