import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { FhirClient } from "./fhir-client.js";
import { TokenManager } from "./token-manager.js";
import type { FetchLike } from "./token-manager.js";
import { registerCapabilitiesTool } from "./tools/capabilities.js";
import { registerEverythingTool } from "./tools/everything.js";
import { registerHistoryTool } from "./tools/history.js";
import { registerReadTool } from "./tools/read.js";
import { registerSearchTool } from "./tools/search.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerWriteTools } from "./tools/writes.js";

export function buildServer(config: Config, fetchFn?: FetchLike): McpServer {
  const tokens = new TokenManager({
    tokenUrl: `${config.baseUrl}/oauth/token`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetchFn,
  });
  const client = new FhirClient(config.baseUrl, tokens, fetchFn);

  const server = new McpServer({
    name: "fhir-mcp-server",
    version: "0.1.0",
  });

  registerCapabilitiesTool(server, client);
  registerSearchTool(server, client, config);
  registerReadTool(server, client);
  registerEverythingTool(server, client, config);
  registerHistoryTool(server, client, config);
  registerValidateTool(server, client);

  if (config.allowWrites) {
    registerWriteTools(server, client);
  }

  return server;
}
