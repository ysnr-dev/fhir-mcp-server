import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FhirError } from "../fhir-client.js";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body, converting FhirError / unexpected errors into MCP tool errors. */
export async function run(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof FhirError) {
      return errorResult(error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Unexpected error: ${message}`);
  }
}

const RESOURCE_TYPE_PATTERN = /^[A-Za-z]+$/;

/** Reject path-breaking resource type values before they reach URL construction. */
export function assertResourceType(resourceType: string): void {
  if (!RESOURCE_TYPE_PATTERN.test(resourceType)) {
    throw new Error(`Invalid resourceType: ${JSON.stringify(resourceType)}`);
  }
}

const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/** FHIR logical id validation (also blocks path traversal). */
export function assertResourceId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid resource id: ${JSON.stringify(id)}`);
  }
}
