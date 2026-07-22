import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatOperationOutcome } from "../fhir-client.js";
import type { FhirClient } from "../fhir-client.js";
import { assertResourceType, jsonResult, run } from "./helpers.js";

export function registerValidateTool(server: McpServer, client: FhirClient): void {
  server.registerTool(
    "validate_fhir",
    {
      title: "Validate a FHIR resource",
      description:
        "Validate a resource against the server's profiles without saving it " +
        "(POST /{resourceType}/$validate). Use this before create_fhir/update_fhir to catch " +
        "structural or terminology errors early. The resource JSON must include resourceType.",
      inputSchema: {
        resource: z
          .record(z.unknown())
          .describe("The FHIR resource to validate (JSON object including resourceType)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resource }) =>
      run(async () => {
        const resourceType = (resource as { resourceType?: unknown }).resourceType;
        if (typeof resourceType !== "string" || !resourceType) {
          throw new Error("resource.resourceType is required");
        }
        assertResourceType(resourceType);
        const outcome = await client.request("POST", `/${resourceType}/$validate`, {
          body: resource,
        });
        const issues = formatOperationOutcome(outcome);
        const hasErrors = issues.some(
          (line) => line.startsWith("[error]") || line.startsWith("[fatal]"),
        );
        return jsonResult({
          valid: !hasErrors,
          issues: issues.length ? issues : ["No issues reported"],
        });
      }),
  );
}
