import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const fixtureTool = Object.freeze({
  name: "qualified_python_fixture",
  description: "Protocol fixture only. Its presence does not prove Fusion compatibility.",
  inputSchema: { type: "object", properties: { script: { type: "string" }, language: { type: "string", enum: ["python"] } }, required: ["script", "language"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true },
});

export const fixtureHandler = `
_calls = 0
print("MODULE_INITIALIZATION_MUST_NOT_LEAK")
def dispatch(request):
    global _calls
    _calls += 1
    print("HANDLER_STDOUT_MUST_NOT_LEAK")
    return {"ok": True, "data": {"operation": request["operation"], "args": request["args"], "calls": _calls}, "state": "fixture-state"}
`;

export async function executePython(script) {
  // Source travels on stdin, not argv (OS argument limits and diagnostics must
  // not expose a complete generated request on a child-process failure).
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FUSION_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Python wrapper fixture exceeded its deadline")); }, 3000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { child.kill(); reject(new Error("Python fixture output exceeded its bound")); } });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 4000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status !== 0 || stderr) reject(new Error(`Python fixture failed (${status ?? signal}): ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(script);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

async function shutdown(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

/** Intentionally independent 2025 session protocol fixture, not a Fusion fake. */
export async function legacyFixture(t, options = {}) {
  const requests = [];
  const calls = [];
  let initialized = false;
  let sessionDeleted = false;
  let listCount = 0;
  let url;
  const session = "fusion-protocol-fixture-session";
  const server = createServer(async (request, response) => {
    const send = (id, result, extra = {}) => {
      if (response.destroyed) return;
      const payload = extra.error ? { jsonrpc: "2.0", id, error: extra.error } : { jsonrpc: "2.0", id, result };
      if (extra.sse) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (extra.notification) response.write(`event: message\ndata: ${JSON.stringify(extra.notification)}\n\n`);
        const event = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
        response.write(event.slice(0, 23));
        response.end(event.slice(23));
      } else {
        response.writeHead(200, { "content-type": "application/json", ...(extra.headers ?? {}) });
        response.end(JSON.stringify(payload));
      }
    };
    try {
      if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
      if (options.redirect) { response.writeHead(307, { location: options.redirect }).end(); return; }
      if (request.method === "GET") { requests.push({ httpMethod: "GET", headers: request.headers }); response.writeHead(405).end(); return; }
      if (request.method === "DELETE") {
        requests.push({ httpMethod: "DELETE", headers: request.headers });
        sessionDeleted = true;
        response.writeHead(204).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) { response.writeHead(413).end(); return; }
      }
      const message = JSON.parse(body);
      requests.push({ ...message, headers: request.headers });
      if (message.method === "server/discover") {
        if (options.hangDiscovery) return;
        send(message.id, undefined, { error: { code: -32601, message: "Method not found" } });
        return;
      }
      if (message.method === "initialize") {
        send(message.id, { protocolVersion: "2025-11-25", serverInfo: { name: "independent-protocol-fixture", version: "1.0" }, capabilities: { tools: { listChanged: true } } }, { headers: { "mcp-session-id": session } });
        return;
      }
      if (message.method === "notifications/initialized") { initialized = true; response.writeHead(202).end(); return; }
      if (message.method === "notifications/cancelled") { response.writeHead(202).end(); return; }
      if (!initialized || request.headers["mcp-session-id"] !== session || request.headers["mcp-protocol-version"] !== "2025-11-25") {
        send(message.id, undefined, { error: { code: -32000, message: "Uninitialized or incorrectly bound session" } });
        return;
      }
      if (message.method === "tools/list") {
        listCount++;
        const listing = options.list ? await options.list(message.params?.cursor, listCount) : { tools: [structuredClone(fixtureTool)] };
        send(message.id, listing, { sse: options.listSse, notification: options.listNotification });
        return;
      }
      if (message.method === "tools/call") {
        calls.push(message.params);
        if (options.disconnect) { request.socket.destroy(); return; }
        if (options.callError) { send(message.id, undefined, { error: options.callError }); return; }
        if (options.oversized) {
          response.writeHead(200, { "content-type": options.callSse ? "text/event-stream" : "application/json", ...(options.contentLength ? { "content-length": options.oversized } : {}) });
          response.end("x".repeat(options.oversized));
          return;
        }
        const result = options.call ? await options.call(message.params, { request, response, calls }) : { content: [{ type: "text", text: await executePython(message.params.arguments.script) }] };
        if (result !== undefined) send(message.id, result, { sse: options.callSse });
        return;
      }
      send(message.id, undefined, { error: { code: -32601, message: "Method not found" } });
    } catch {
      if (!response.destroyed && !response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      if (!response.destroyed) response.end("Protocol fixture failure");
    }
  });
  url = await listen(server);
  t.after(() => shutdown(server));
  return { url, requests, calls, server, get initialized() { return initialized; }, get sessionDeleted() { return sessionDeleted; } };
}

/** Real SDK2 server over a TCP loopback socket, in either modern response mode. */
export async function modernFixture(t, responseMode = "json", options = {}) {
  const requests = [];
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "sdk2-protocol-fixture", version: "1.0.0" });
    server.registerTool("qualified_python_fixture", {
      inputSchema: z.object({ script: z.string(), language: z.literal("python") }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async args => {
      calls.push(args);
      if (options.call) return options.call(args);
      return { content: [{ type: "text", text: await executePython(args.script) }] };
    });
    return server;
  }, { responseMode, legacy: "reject", keepAliveMs: 0 });
  let url;
  const server = createServer(async (request, response) => {
    try {
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      const message = body.length ? JSON.parse(body) : undefined;
      if (message) requests.push(message);
      if (message?.method === "tools/call" && (options.rawCallError || options.rawCallResult)) {
        calls.push(message.params.arguments);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(options.rawCallError ? { error: options.rawCallError } : { result: options.rawCallResult }) }));
        return;
      }
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const webRequest = new Request(url, { method: request.method, headers: request.headers, ...(body.length ? { body } : {}), signal: abort.signal });
      const webResponse = await handler.fetch(webRequest);
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      if (webResponse.body) for await (const chunk of webResponse.body) response.write(chunk);
      response.end();
    } catch {
      if (!response.destroyed && !response.headersSent) response.writeHead(500);
      if (!response.destroyed) response.end();
    }
  });
  url = await listen(server);
  t.after(async () => { await handler.close(); await shutdown(server); });
  return { url, requests, calls, handler };
}
