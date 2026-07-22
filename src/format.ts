import { DEFAULT_SEARCH_COUNT } from "./config.js";

/** Clamp a requested `_count` into [1, maxCount], falling back to the default. */
export function clampCount(requested: number | undefined, maxCount: number): number {
  const count = requested ?? DEFAULT_SEARCH_COUNT;
  return Math.max(1, Math.min(count, maxCount));
}

interface BundleLike {
  resourceType?: string;
  total?: number;
  link?: Array<{ relation?: string; url?: string }>;
  entry?: Array<{ resource?: unknown }>;
}

export interface BundleSummary {
  /** Server-reported total number of matches (absent if the server omitted it). */
  total?: number;
  /** Number of resources included in this response. */
  returned: number;
  hasNextPage: boolean;
  resources: unknown[];
  /** Present when resources were dropped to keep the response small. */
  guidance?: string;
}

/** Character budget for the serialized resource list sent back to the model. */
const MAX_RESOURCES_CHARS = 50_000;

/**
 * Flatten a search/history Bundle into { total, returned, hasNextPage, resources },
 * truncating the resource list when it would blow up the response size.
 */
export function summarizeBundle(
  bundle: unknown,
  maxChars: number = MAX_RESOURCES_CHARS,
): BundleSummary {
  const b = (bundle ?? {}) as BundleLike;
  const entries = b.entry ?? [];
  const resources = entries.map((entry) => entry.resource).filter((r) => r !== undefined);
  const hasNextPage = (b.link ?? []).some((link) => link.relation === "next");

  let used = 0;
  const kept: unknown[] = [];
  for (const resource of resources) {
    used += JSON.stringify(resource).length;
    if (kept.length > 0 && used > maxChars) break;
    kept.push(resource);
  }

  const summary: BundleSummary = {
    total: b.total,
    returned: kept.length,
    hasNextPage,
    resources: kept,
  };
  if (kept.length < resources.length) {
    summary.guidance =
      `Response truncated: showing ${kept.length} of ${resources.length} returned resources. ` +
      "Narrow the result with search parameters, lower _count, or request fewer fields via _elements or _summary=true.";
  }
  return summary;
}

interface CapabilityStatementLike {
  fhirVersion?: string;
  software?: { name?: string; version?: string };
  implementation?: { description?: string };
  rest?: Array<{
    mode?: string;
    resource?: Array<{
      type?: string;
      interaction?: Array<{ code?: string }>;
      searchParam?: Array<{ name?: string; type?: string }>;
      operation?: Array<{ name?: string }>;
      searchInclude?: string[];
      searchRevInclude?: string[];
    }>;
    operation?: Array<{ name?: string }>;
  }>;
}

/** Compact summary of a CapabilityStatement: what the AI needs to discover usage. */
export function summarizeCapabilities(statement: unknown): Record<string, unknown> {
  const cs = (statement ?? {}) as CapabilityStatementLike;
  const rest = cs.rest?.find((r) => r.mode === "server") ?? cs.rest?.[0];

  return {
    fhirVersion: cs.fhirVersion,
    software: cs.software
      ? `${cs.software.name ?? "?"} ${cs.software.version ?? ""}`.trim()
      : undefined,
    description: cs.implementation?.description,
    systemOperations: rest?.operation?.map((op) => `$${op.name}`) ?? [],
    resources: (rest?.resource ?? []).map((resource) => ({
      type: resource.type,
      interactions: resource.interaction?.map((i) => i.code) ?? [],
      searchParams: (resource.searchParam ?? []).map((p) =>
        p.type ? `${p.name} (${p.type})` : p.name,
      ),
      operations: resource.operation?.map((op) => `$${op.name}`) ?? [],
      includes: resource.searchInclude ?? [],
      revIncludes: resource.searchRevInclude ?? [],
    })),
  };
}
