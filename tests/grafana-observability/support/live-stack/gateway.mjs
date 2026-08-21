import { createServer, request as httpRequest } from "node:http";

const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const ALLOWED_DATASOURCES = new Set(["live-prometheus", "live-loki", "live-tempo", "live-postgres"]);

function allowed(method, url) {
  if (method === "POST") return url.pathname === "/api/ds/query" && url.search === "";
  if (method !== "GET") return false;
  if (["/api/health", "/api/datasources", "/api/access-control/user/permissions"].includes(url.pathname)) return url.search === "";
  const datasource = /^\/api\/datasources\/uid\/([^/]+)(?:\/health)?$/u.exec(url.pathname);
  if (datasource) return ALLOWED_DATASOURCES.has(datasource[1]) && url.search === "";
  // A fixed, read-only Tempo search route for the compatibility regression.
  if (url.pathname !== "/api/datasources/proxy/uid/live-tempo/api/search") return false;
  return [...url.searchParams.keys()].every((key) => ["q", "start", "end", "limit", "spss"].includes(key));
}

const server = createServer((incoming, outgoing) => {
  let url;
  try { url = new URL(incoming.url, "http://grafana:3000"); } catch { outgoing.writeHead(400).end(); return; }
  if (url.origin !== "http://grafana:3000" || !allowed(incoming.method, url)) {
    outgoing.writeHead(403, { "content-type": "application/json" }).end('{"error":"test_gateway_route_denied"}');
    incoming.resume();
    return;
  }
  let inputBytes = 0;
  let outputBytes = 0;
  const upstream = httpRequest({
    hostname: "grafana",
    port: 3000,
    method: incoming.method,
    path: `${url.pathname}${url.search}`,
    headers: { accept: "application/json", ...(incoming.method === "POST" ? { "content-type": "application/json" } : {}) },
    timeout: 15_000,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, { "content-type": "application/json" });
    response.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) { upstream.destroy(); outgoing.destroy(); }
      else outgoing.write(chunk);
    });
    response.on("end", () => outgoing.end());
    response.on("error", () => outgoing.destroy());
  });
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "application/json" });
    outgoing.end('{"error":"test_gateway_upstream_unavailable"}');
  });
  incoming.on("data", (chunk) => {
    inputBytes += chunk.length;
    if (inputBytes > MAX_REQUEST_BYTES) { upstream.destroy(); incoming.destroy(); }
    else upstream.write(chunk);
  });
  incoming.on("end", () => upstream.end());
  incoming.on("aborted", () => upstream.destroy());
});
server.requestTimeout = 20_000;
server.headersTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(3000, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
