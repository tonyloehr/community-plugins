import { createServer } from "node:http";

const labels = 'environment="simulation",service="checkout",instance="host-alpha"';
const samples = Object.freeze([
  ["pm_live_cpu_usage_percent", 97],
  ["pm_live_memory_load_percent", 82],
  ["pm_live_disk_free_percent", 8],
  ["pm_live_system_load_ratio", 2.1],
]);
const body = `${samples.map(([name, value]) => `# TYPE ${name} gauge\n${name}{${labels}} ${value}`).join("\n")}\n`;
const server = createServer((request, response) => {
  if (request.method !== "GET") return response.writeHead(405).end();
  if (request.url === "/healthz") return response.writeHead(200).end("ok\n");
  if (request.url === "/metrics") return response.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(body);
  response.writeHead(404).end();
});
server.requestTimeout = 5_000;
server.headersTimeout = 2_000;
server.listen(8080, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
