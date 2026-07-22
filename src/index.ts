#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error(
    `fhir-mcp-server connected to ${config.baseUrl} ` +
      `(auth: ${config.clientId ? "client_credentials" : "disabled"}, writes: ${config.allowWrites ? "enabled" : "disabled"})`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
