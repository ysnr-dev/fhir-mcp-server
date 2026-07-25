#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { buildAuthRouterOptions, buildOAuthProvider } from "./auth.js";
import { loadConfig, loadHttpConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const http = loadHttpConfig();
  const provider = buildOAuthProvider(http.oauth);

  const app = express();
  app.use(express.json());

  // Health check for the hosting platform (Cloud Run 等). Not part of MCP.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // OAuth metadata + authorize/token/register proxy to the external IdP,
  // plus this server's protected-resource metadata. Must be mounted at root.
  app.use(mcpAuthRouter({ provider, ...buildAuthRouterOptions(http) }));

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${http.publicUrl}/mcp`)),
  });

  // One StreamableHTTP transport per MCP session, keyed by session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        res
          .status(400)
          .json(jsonRpcError("Bad Request: no valid session ID for a non-initialize request"));
        return;
      }
      // New session: create a transport and wire it to a fresh McpServer.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildServer(config);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET opens the SSE stream; DELETE terminates the session.
  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", bearerAuth, handleSessionRequest);
  app.delete("/mcp", bearerAuth, handleSessionRequest);

  app.listen(http.port, () => {
    // stdout is safe here (HTTP transport, not stdio); log startup info.
    console.log(
      `fhir-mcp-server (HTTP) listening on :${http.port} → FHIR ${config.baseUrl} ` +
        `(public: ${http.publicUrl}, auth: OAuth via ${http.oauth.issuerUrl}, ` +
        `writes: ${config.allowWrites ? "enabled" : "disabled"})`,
    );
  });
}

function jsonRpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
