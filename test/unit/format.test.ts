import { describe, expect, it } from "vitest";
import { clampCount, summarizeBundle, summarizeCapabilities } from "../../src/format.js";

describe("clampCount", () => {
  it("defaults to 20 when unset", () => {
    expect(clampCount(undefined, 50)).toBe(20);
  });

  it("clamps to the configured max", () => {
    expect(clampCount(500, 50)).toBe(50);
  });

  it("passes through values within range", () => {
    expect(clampCount(5, 50)).toBe(5);
  });

  it("clamps the default down when max is lower", () => {
    expect(clampCount(undefined, 10)).toBe(10);
  });
});

describe("summarizeBundle", () => {
  const bundle = {
    resourceType: "Bundle",
    type: "searchset",
    total: 42,
    link: [
      { relation: "self", url: "http://fhir.example/Patient?_count=2" },
      { relation: "next", url: "http://fhir.example/Patient?_count=2&page=2" },
    ],
    entry: [
      { resource: { resourceType: "Patient", id: "p1" } },
      { resource: { resourceType: "Patient", id: "p2" } },
    ],
  };

  it("flattens entries and reports total and next page", () => {
    const summary = summarizeBundle(bundle);
    expect(summary.total).toBe(42);
    expect(summary.returned).toBe(2);
    expect(summary.hasNextPage).toBe(true);
    expect(summary.resources).toEqual([
      { resourceType: "Patient", id: "p1" },
      { resourceType: "Patient", id: "p2" },
    ]);
    expect(summary.guidance).toBeUndefined();
  });

  it("handles an empty bundle", () => {
    const summary = summarizeBundle({ resourceType: "Bundle", type: "searchset", total: 0 });
    expect(summary.returned).toBe(0);
    expect(summary.hasNextPage).toBe(false);
    expect(summary.resources).toEqual([]);
  });

  it("truncates oversized responses and adds guidance", () => {
    const big = {
      entry: Array.from({ length: 10 }, (_, i) => ({
        resource: { resourceType: "Observation", id: `o${i}`, note: "x".repeat(400) },
      })),
    };
    const summary = summarizeBundle(big, 1000);
    expect(summary.returned).toBeLessThan(10);
    expect(summary.returned).toBeGreaterThan(0);
    expect(summary.guidance).toMatch(/_elements|_summary/);
  });

  it("always keeps at least one resource even if it exceeds the budget", () => {
    const big = { entry: [{ resource: { resourceType: "Patient", note: "x".repeat(5000) } }] };
    const summary = summarizeBundle(big, 100);
    expect(summary.returned).toBe(1);
  });
});

describe("summarizeCapabilities", () => {
  it("summarizes resources, search params, and operations", () => {
    const summary = summarizeCapabilities({
      resourceType: "CapabilityStatement",
      fhirVersion: "4.0.1",
      software: { name: "fhir-server", version: "1.0.0" },
      rest: [
        {
          mode: "server",
          operation: [{ name: "validate" }],
          resource: [
            {
              type: "Patient",
              interaction: [{ code: "read" }, { code: "search-type" }],
              searchParam: [
                { name: "name", type: "string" },
                { name: "birthdate", type: "date" },
              ],
              operation: [{ name: "everything" }],
              searchInclude: ["Patient:organization"],
            },
          ],
        },
      ],
    });

    expect(summary.fhirVersion).toBe("4.0.1");
    expect(summary.software).toBe("fhir-server 1.0.0");
    expect(summary.systemOperations).toEqual(["$validate"]);
    expect(summary.resources).toEqual([
      {
        type: "Patient",
        interactions: ["read", "search-type"],
        searchParams: ["name (string)", "birthdate (date)"],
        operations: ["$everything"],
        includes: ["Patient:organization"],
        revIncludes: [],
      },
    ]);
  });
});
