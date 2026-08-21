import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "8080");
const lokiPushUrl = process.env.LOKI_PUSH_URL ?? "http://loki:3100/loki/api/v1/push";
const tempoOtlpUrl = process.env.TEMPO_OTLP_URL ?? "http://tempo:4318/v1/traces";

if (
  port !== 8080 ||
  lokiPushUrl !== "http://loki:3100/loki/api/v1/push" ||
  tempoOtlpUrl !== "http://tempo:4318/v1/traces"
) {
  throw new Error("The simulated seed accepts only the checked-in internal endpoints");
}

const devices = Object.freeze([
  { id: "edge-001", telemetry: 17.0, ageSeconds: 10 },
  { id: "edge-002", telemetry: 17.1, ageSeconds: 20 },
  { id: "edge-003", telemetry: 17.2, ageSeconds: 30 },
  { id: "edge-004", telemetry: 17.3, ageSeconds: 40 },
  { id: "edge-005", telemetry: 17.4, ageSeconds: 420 },
]);

let scrapeSequence = 0;
let seedSequence = 0;
let lastSeedAt = "";

function metricLine(name, labels, value, timestampMs) {
  const rendered = Object.entries(labels)
    .map(([key, label]) => `${key}="${label}"`)
    .join(",");
  return `${name}{${rendered}} ${value}${timestampMs === undefined ? "" : ` ${timestampMs}`}`;
}

function metrics() {
  scrapeSequence += 1;
  const successes = scrapeSequence * 4;
  const errors = scrapeSequence;
  const staleTimestampMs = Date.now() - 120_000;
  const lines = [
    "# HELP pm_live_fixture_info Synthetic live-provider matrix identity.",
    "# TYPE pm_live_fixture_info gauge",
    metricLine("pm_live_fixture_info", { origin: "SIMULATED", environment: "simulation" }, 1),
    "# TYPE pm_live_cpu_usage_percent gauge",
    metricLine("pm_live_cpu_usage_percent", { environment: "simulation", service: "checkout", instance: "host-alpha" }, 97),
    "# TYPE pm_live_memory_load_percent gauge",
    metricLine("pm_live_memory_load_percent", { environment: "simulation", service: "checkout", instance: "host-alpha" }, 82),
    "# TYPE pm_live_disk_free_percent gauge",
    metricLine("pm_live_disk_free_percent", { environment: "simulation", service: "checkout", instance: "host-alpha" }, 8),
    "# TYPE pm_live_system_load_ratio gauge",
    metricLine("pm_live_system_load_ratio", { environment: "simulation", service: "checkout", instance: "host-alpha" }, 2.1),
    "# TYPE pm_live_healthy_probe_percent gauge",
    metricLine("pm_live_healthy_probe_percent", { environment: "simulation", service: "checkout" }, 42),
    "# TYPE pm_live_stale_probe_percent gauge",
    metricLine("pm_live_stale_probe_percent", { environment: "simulation", service: "checkout" }, 42, staleTimestampMs),
    "# TYPE pm_live_contradiction_probe_percent gauge",
    metricLine("pm_live_contradiction_probe_percent", { environment: "simulation", service: "checkout" }, 42),
    "# TYPE pm_live_request_rate gauge",
    metricLine("pm_live_request_rate", { environment: "simulation", service: "checkout" }, 120),
    "# TYPE pm_live_error_rate_percent gauge",
    metricLine("pm_live_error_rate_percent", { environment: "simulation", service: "checkout" }, 20),
    "# TYPE pm_live_latency_p95_milliseconds gauge",
    metricLine("pm_live_latency_p95_milliseconds", { environment: "simulation", service: "checkout" }, 1250),
    "# TYPE pm_live_checkout_requests_total counter",
    metricLine("pm_live_checkout_requests_total", { environment: "simulation", service: "checkout", status_code: "200" }, successes),
    metricLine("pm_live_checkout_requests_total", { environment: "simulation", service: "checkout", status_code: "503" }, errors),
  ];
  for (const device of devices) {
    lines.push(
      metricLine("pm_live_iot_telemetry", { environment: "simulation", device: device.id }, device.telemetry),
      metricLine("pm_live_device_age_seconds", { environment: "simulation", device: device.id }, device.ageSeconds),
    );
  }
  return `${lines.join("\n")}\n`;
}

function logStreams(nowNs) {
  const common = { environment: "simulation", service: "checkout", subject: "host-alpha", origin: "SIMULATED" };
  return [
    {
      stream: { ...common, level: "info", event_kind: "request" },
      values: [[nowNs, JSON.stringify({ message: "checkout completed", level: "info", status_code: 200 })]],
    },
    {
      stream: { ...common, level: "error", event_kind: "request" },
      values: [[String(BigInt(nowNs) + 1n), JSON.stringify({ message: "checkout payment timeout", level: "error", status_code: 503 })]],
    },
    {
      stream: { ...common, level: "warning", event_kind: "security" },
      values: [[String(BigInt(nowNs) + 2n), JSON.stringify({ message: "synthetic denied access marker", level: "warning", status_code: 401, security_marker: true })]],
    },
  ];
}

function otlpTrace(sequence, nowMs) {
  const suffix = sequence.toString(16).padStart(8, "0").slice(-8);
  const traceId = `111111111111111111111111${suffix}`;
  const start = BigInt(nowMs) * 1_000_000n;
  const end = start + 1_250_000_000n;
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "checkout" } },
          { key: "deployment.environment", value: { stringValue: "simulation" } },
          { key: "telemetry.origin", value: { stringValue: "SIMULATED" } },
        ],
      },
      scopeSpans: [{
        scope: { name: "production-monitoring-live-fixture", version: "1.0.0" },
        spans: [{
          traceId,
          spanId: `22222222${suffix}`,
          name: "checkout.bank_transfer",
          kind: 2,
          startTimeUnixNano: start.toString(),
          endTimeUnixNano: end.toString(),
          attributes: [
            { key: "http.response.status_code", value: { intValue: "503" } },
            { key: "error.type", value: { stringValue: "payment_timeout" } },
          ],
          status: { code: 2, message: "SIMULATED checkout timeout" },
        }],
      }],
    }],
  };
}

async function postJson(url, value) {
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
    signal: globalThis.AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Synthetic seed destination returned HTTP ${response.status}`);
}

async function publishSeed() {
  seedSequence += 1;
  const nowMs = Date.now();
  const nowNs = (BigInt(nowMs) * 1_000_000n).toString();
  await Promise.all([
    postJson(lokiPushUrl, { streams: logStreams(nowNs) }),
    postJson(tempoOtlpUrl, otlpTrace(seedSequence, nowMs)),
  ]);
  lastSeedAt = new Date(nowMs).toISOString();
}

async function initialize() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await publishSeed();
      return;
    } catch {
      if (attempt === 30) throw new Error("Synthetic seed destinations did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

await initialize();

const server = createServer((request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end('{"error":"method_not_allowed"}\n');
    return;
  }
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ status: "ok", origin: "SIMULATED", lastSeedAt })}\n`);
    return;
  }
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(metrics());
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}\n');
});

server.listen(port, "0.0.0.0");
const refresh = globalThis.setInterval(() => {
  void publishSeed().catch(() => {
    process.stderr.write("Synthetic seed refresh failed\n");
  });
}, 10_000);
refresh.unref();
