import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FhirClient } from "../fhir-client.js";
import { assertResourceId, assertResourceType, jsonResult, run } from "./helpers.js";

const VALIDATE_FIRST =
  "Consider running validate_fhir on the resource first to catch errors before writing.";

function extractResourceType(resource: Record<string, unknown>): string {
  const resourceType = resource.resourceType;
  if (typeof resourceType !== "string" || !resourceType) {
    throw new Error("resource.resourceType is required");
  }
  assertResourceType(resourceType);
  return resourceType;
}

/** Registered only when FHIR_MCP_ALLOW_WRITES=true. Delete is intentionally not provided. */
export function registerWriteTools(server: McpServer, client: FhirClient): void {
  server.registerTool(
    "create_fhir",
    {
      title: "Create a FHIR resource",
      description:
        "Create a new resource (POST /{resourceType}). Supports conditional create via " +
        `ifNoneExist to avoid duplicates. ${VALIDATE_FIRST}`,
      inputSchema: {
        resource: z
          .record(z.unknown())
          .describe("The FHIR resource to create (JSON object including resourceType)"),
        ifNoneExist: z
          .string()
          .optional()
          .describe(
            'Conditional-create search criteria for the If-None-Exist header, e.g. "identifier=http://example.org/mrn|12345"',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ resource, ifNoneExist }) =>
      run(async () => {
        const resourceType = extractResourceType(resource);
        const created = await client.request("POST", `/${resourceType}`, {
          body: resource,
          headers: ifNoneExist ? { "If-None-Exist": ifNoneExist } : undefined,
        });
        return jsonResult(created);
      }),
  );

  server.registerTool(
    "update_fhir",
    {
      title: "Update a FHIR resource",
      description:
        "Replace an existing resource (PUT /{resourceType}/{id}). Supports optimistic locking " +
        `via ifMatch (the resource's current version id). ${VALIDATE_FIRST}`,
      inputSchema: {
        resourceType: z.string().describe("FHIR resource type, e.g. Patient"),
        id: z.string().describe("Logical id of the resource to update"),
        resource: z.record(z.unknown()).describe("The full replacement resource (JSON object)"),
        ifMatch: z
          .string()
          .optional()
          .describe('Expected current versionId for the If-Match header, e.g. "3" or W/"3"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ resourceType, id, resource, ifMatch }) =>
      run(async () => {
        assertResourceType(resourceType);
        assertResourceId(id);
        const bodyType = (resource as { resourceType?: unknown }).resourceType;
        if (bodyType !== undefined && bodyType !== resourceType) {
          throw new Error(
            `resource.resourceType (${String(bodyType)}) does not match resourceType (${resourceType})`,
          );
        }
        const bodyId = (resource as { id?: unknown }).id;
        if (bodyId !== undefined && bodyId !== id) {
          throw new Error(`resource.id (${String(bodyId)}) does not match id (${id})`);
        }
        const body = { ...resource, resourceType, id };
        const updated = await client.request("PUT", `/${resourceType}/${id}`, {
          body,
          headers: ifMatch ? { "If-Match": normalizeETag(ifMatch) } : undefined,
        });
        return jsonResult(updated);
      }),
  );

  server.registerTool(
    "patch_fhir",
    {
      title: "Patch a FHIR resource",
      description:
        "Apply a JSON Patch (RFC 6902) to an existing resource (PATCH /{resourceType}/{id}). " +
        `Supports optimistic locking via ifMatch. ${VALIDATE_FIRST}`,
      inputSchema: {
        resourceType: z.string().describe("FHIR resource type, e.g. Patient"),
        id: z.string().describe("Logical id of the resource to patch"),
        patch: z
          .array(z.record(z.unknown()))
          .describe(
            'JSON Patch operations, e.g. [{"op": "replace", "path": "/name/0/family", "value": "山田"}]',
          ),
        ifMatch: z
          .string()
          .optional()
          .describe('Expected current versionId for the If-Match header, e.g. "3" or W/"3"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ resourceType, id, patch, ifMatch }) =>
      run(async () => {
        assertResourceType(resourceType);
        assertResourceId(id);
        const patched = await client.request("PATCH", `/${resourceType}/${id}`, {
          body: patch,
          headers: {
            "Content-Type": "application/json-patch+json",
            ...(ifMatch ? { "If-Match": normalizeETag(ifMatch) } : {}),
          },
        });
        return jsonResult(patched);
      }),
  );
}

/** Accept a bare versionId ("3") or a full weak ETag (W/"3"). */
function normalizeETag(value: string): string {
  return /^W\//.test(value) || value.startsWith('"') ? value : `W/"${value}"`;
}
