import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopProvider, DesktopRequest, DesktopResponse } from "./types.js";
import { validateDesktopRequest, validateDesktopResponse } from "./native-script.js";
import { boundedInteger, boundedJson, cloneNativeJson, createBoundedNativeFetch, isRecord, NativeFusionError, validateNativeEndpoint } from "./native-security.js";

const execFileAsync = promisify(execFile);
const MAX_ADDIN_REQUEST_BYTES = 2 * 1024 * 1024;
const READ_OPERATIONS = new Set([
  "documents.list", "document.inspect", "parameters.list", "entities.find", "geometry.measure", "geometry.check",
  "configurations.list", "materials.list", "render.status", "cam.inspect", "cam.status",
  "bom.inspect", "cam.setup_schema", "cam.operation_schema", "cam.tools_list", "cam.machining_time",
]);

const WINDOWS_ACL_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:CODEX_FUSION_PAIRING_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne 'S-1-5-18') { exit 3 }
}
Write-Output 'PRIVATE'
`;

/**
 * The add-in rejects browser Fetch-Metadata. Node's global fetch adds
 * Sec-Fetch-Mode even outside browsers, so use Node HTTP for this narrow local
 * IPC route. Response sizing/deadlines are still enforced by the shared
 * bounded Fetch wrapper; no redirect following or general network proxy exists.
 */
export const addinLocalFetch: typeof fetch = async (input, init) => {
  const endpoint = input instanceof URL ? input : validateNativeEndpoint(input instanceof Request ? input.url : String(input));
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || endpoint.pathname !== "/dispatch" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new NativeFusionError("INVALID_ENDPOINT", "The add-in HTTP client only supports the configured literal loopback /dispatch route.");
  }
  const method = init?.method ?? "GET";
  if (!["GET", "POST"].includes(method) || (init?.body !== undefined && typeof init.body !== "string")) {
    throw new NativeFusionError("INVALID_REQUEST", "The add-in HTTP client accepts only GET or typed JSON POST bodies.");
  }
  const body = typeof init?.body === "string" ? init.body : undefined;
  if (body !== undefined && Buffer.byteLength(body) > MAX_ADDIN_REQUEST_BYTES) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Add-in request exceeds its byte limit.");
  const headers = new Headers(init?.headers);
  if (body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(body)));
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(endpoint, { method, headers: Object.fromEntries(headers), ...(init?.signal ? { signal: init.signal } : {}), maxHeaderSize: 16_384 }, incoming => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      const status = incoming.statusCode ?? 500;
      if ([204, 205, 304].includes(status)) { incoming.resume(); resolve(new Response(null, { status, headers: responseHeaders })); }
      else resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
};

interface Pairing {
  version: 1;
  url: string;
  token: string;
  session_id: string;
  handler_hash: string;
}

export interface AddinDesktopProviderOptions {
  url: string;
  tokenFile: string;
  /** SHA-256 of the canonical installed handlers/fusion_runtime.py. */
  handlerHash: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface AddinConnectionInfo {
  provider: "addin";
  endpoint: string;
  sessionId: string;
  handlerHash: string;
  authenticated: true;
  trustBoundary: "same_os_user";
  liveQualification: "not_inferred";
}

function fail(code: string, message: string, outcome: "none" | "unknown" = "none"): DesktopResponse {
  return { ok: false, error: { code, message, outcome } };
}

function safeFailure(error: unknown): NativeFusionError {
  if (error instanceof NativeFusionError) return error;
  return new NativeFusionError("ADDIN_UNAVAILABLE", "The local typed Fusion add-in could not be reached or verified. Check its selected port, session, and private pairing-file permissions.");
}

async function verifyPrivatePath(filename: string, directory: boolean): Promise<Awaited<ReturnType<typeof lstat>>> {
  const stat = await lstat(filename);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing paths must be ordinary directories and regular files, without symbolic links.");
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new NativeFusionError("ACL_UNVERIFIED", "Cannot locate Windows ACL verification.");
    try {
      const { stdout } = await execFileAsync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL_CHECK, "utf16le").toString("base64"),
      ], { env: { ...process.env, CODEX_FUSION_PAIRING_PATH: filename }, timeout: 15_000, maxBuffer: 16_384, windowsHide: true });
      if (stdout.trim() !== "PRIVATE") throw new Error("ACL rejected");
    } catch {
      throw new NativeFusionError("ACL_UNVERIFIED", "The add-in pairing path is not verified as private to the current Windows user and SYSTEM.");
    }
  } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing storage must belong to this user with no group or other permissions (0700/0600).");
  }
  return stat;
}

/** Secret values remain private; this function is deliberately not exported. */
async function readPairing(filename: string, endpoint: string, handlerHash: string): Promise<Pairing> {
  const directory = path.dirname(filename);
  const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!samePath(await realpath(directory), directory)) throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Use a canonical absolute pairing directory without linked ancestors.");
  await verifyPrivatePath(directory, true);
  const before = await verifyPrivatePath(filename, false);
  if (!samePath(await realpath(filename), filename)) throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing files cannot be linked or redirected.");
  if (before.size > 8192) throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing file exceeds its byte limit.");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let pairing: unknown;
  try {
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino || !opened.isFile() || opened.size > 8192
      || (process.platform !== "win32" && (opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0))) {
      throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing file changed during access.");
    }
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > 8192) throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Add-in pairing file exceeds its byte limit.");
    try { pairing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))); }
    catch { throw new NativeFusionError("INVALID_PAIRING_FILE", "The private add-in pairing file is not valid JSON."); }
  } finally { await handle.close(); }
  let pairedUrl: string | undefined;
  if (isRecord(pairing) && typeof pairing.url === "string") {
    try { pairedUrl = new URL(pairing.url).href; } catch { /* Rejected below, without exposing the value. */ }
  }
  if (!isRecord(pairing) || Object.keys(pairing).some(key => !["version", "url", "token", "session_id", "handler_hash"].includes(key))
    || pairing.version !== 1 || pairedUrl !== endpoint || pairing.handler_hash !== handlerHash
    || typeof pairing.token !== "string" || !/^[a-f0-9]{64}$/u.test(pairing.token)
    || typeof pairing.session_id !== "string" || !/^fusion_addin_[a-f0-9]{32}$/u.test(pairing.session_id)) {
    throw new NativeFusionError("PAIRING_MISMATCH", "The pairing file does not match the configured endpoint, reviewed handler, or supported session format.");
  }
  return pairing as unknown as Pairing;
}

function hmac(token: string, prefix: string, body: string): string {
  return createHmac("sha256", Buffer.from(token, "hex")).update(prefix, "utf8").update(body, "utf8").digest("hex");
}

/**
 * Optional typed add-in route. There is no fallback from native MCP, generic
 * script submission, credential disclosure, or automatic write retry here.
 * Authentication protects the local pairing boundary; it is not a user/role
 * policy engine or a sandbox against code running as the same OS user.
 */
export class AddinDesktopProvider implements DesktopProvider {
  private readonly endpoint: URL;
  private readonly tokenFile: string;
  private readonly handlerHash: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private lifetime = new AbortController();
  private closed = false;

  constructor(options: AddinDesktopProviderOptions) {
    this.endpoint = validateNativeEndpoint(options.url);
    if (this.endpoint.protocol !== "http:" || this.endpoint.pathname !== "/dispatch") {
      throw new NativeFusionError("INVALID_ENDPOINT", "The typed add-in endpoint must be its explicitly configured HTTP loopback /dispatch URL.");
    }
    if (typeof options.tokenFile !== "string" || !path.isAbsolute(options.tokenFile) || path.normalize(options.tokenFile) !== options.tokenFile || /^[/\\]{2}/u.test(options.tokenFile)) {
      throw new NativeFusionError("UNSAFE_PAIRING_FILE", "Configure an explicit, normalized absolute add-in pairing-file path.");
    }
    if (typeof options.handlerHash !== "string" || !/^[a-f0-9]{64}$/u.test(options.handlerHash)) {
      throw new NativeFusionError("INVALID_HANDLER", "The typed add-in provider requires the canonical installed handler SHA-256.");
    }
    this.tokenFile = options.tokenFile;
    this.handlerHash = options.handlerHash;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, "timeoutMs", 100, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes", 1024, 4 * 1024 * 1024);
    this.fetchImpl = options.fetchImpl ?? addinLocalFetch;
  }

  async connect(): Promise<AddinConnectionInfo> {
    if (this.closed) { this.lifetime = new AbortController(); this.closed = false; }
    const pairing = await readPairing(this.tokenFile, this.endpoint.href, this.handlerHash);
    const response = await this.exchange("GET", pairing);
    if (!response.ok) throw new NativeFusionError("ADDIN_UNAVAILABLE", "The signed add-in status response did not confirm availability.");
    return { provider: "addin", endpoint: this.endpoint.href, sessionId: pairing.session_id, handlerHash: pairing.handler_hash,
      authenticated: true, trustBoundary: "same_os_user", liveQualification: "not_inferred" };
  }

  async dispatch(request: DesktopRequest): Promise<DesktopResponse> {
    let submitted = false;
    let readOnly = false;
    try {
      if (this.closed) throw new NativeFusionError("NATIVE_CANCELLED", "The add-in provider is closed. Reconnect explicitly before continuing.");
      const clean = validateDesktopRequest(request);
      readOnly = READ_OPERATIONS.has(clean.operation);
      const pairing = await readPairing(this.tokenFile, this.endpoint.href, this.handlerHash);
      // Confirm possession of the private session secret before sending CAD
      // arguments. A token is never sent to an arbitrary listener as a bearer.
      const status = await this.exchange("GET", pairing);
      if (!status.ok) throw new NativeFusionError("ADDIN_UNAVAILABLE", "The signed add-in status check failed before execution.");
      if (this.closed) throw new NativeFusionError("NATIVE_CANCELLED", "The add-in provider was closed before submission.");
      // Build and validate the entire request before marking submission.
      const body = boundedJson({ version: 1, session_id: pairing.session_id, handler_hash: pairing.handler_hash, request: clean }, MAX_ADDIN_REQUEST_BYTES);
      submitted = true;
      const result = await this.exchange("POST", pairing, clean.request_id, body);
      if (!result.ok && !readOnly && result.error.outcome !== "none" && result.error.outcome !== "partial") {
        return fail("OUTCOME_UNKNOWN", "The add-in operation has an unconfirmed outcome. Reconcile the exact Fusion state before retrying; timeout is not rollback.", "unknown");
      }
      // Preserve authenticated uncertainty about a prior asynchronous job.
      return result;
    } catch (error) {
      if (submitted && !readOnly) return fail("OUTCOME_UNKNOWN", "The add-in may have applied the operation. It was not retried; reconcile Fusion before another write.", "unknown");
      const safe = safeFailure(error);
      return fail(safe.code, safe.message);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new NativeFusionError("NATIVE_CANCELLED", "The add-in client closed; provider execution may still be running."));
  }

  private async exchange(method: "GET" | "POST", pairing: Pairing, requestId: string | null = null, body = ""): Promise<DesktopResponse> {
    if (this.closed) throw new NativeFusionError("NATIVE_CANCELLED", "The add-in client is closed.");
    const nonce = randomBytes(24).toString("hex");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hmac(pairing.token, `request\n${method}\n/dispatch\n${pairing.session_id}\n${nonce}\n${timestamp}\n`, body);
    const boundedFetch = createBoundedNativeFetch({ endpoint: this.endpoint, timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes,
      connectionSignal: this.lifetime.signal, fetchImpl: this.fetchImpl });
    const response = await boundedFetch(this.endpoint, {
      method, ...(method === "POST" ? { body } : {}),
      headers: { "Content-Type": "application/json", "X-Codex-Fusion-Session": pairing.session_id,
        "X-Codex-Fusion-Nonce": nonce, "X-Codex-Fusion-Timestamp": timestamp, "X-Codex-Fusion-Signature": signature },
    });
    const resultText = await response.text();
    const signed = response.headers.get("X-Codex-Fusion-Signature");
    const expected = hmac(pairing.token, `response\n${nonce}\n${response.status}\n`, resultText);
    if (!signed || !/^[a-f0-9]{64}$/u.test(signed) || !timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(expected, "hex"))) {
      throw new NativeFusionError("AUTHENTICATION_FAILED", "The local add-in response signature could not be verified.");
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new NativeFusionError("INVALID_ADDIN_RESULT", "The authenticated add-in result is not JSON.");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(resultText); } catch { throw new NativeFusionError("INVALID_ADDIN_RESULT", "The authenticated add-in result is malformed."); }
    decoded = cloneNativeJson(decoded, this.maxResponseBytes);
    if (!isRecord(decoded) || Object.keys(decoded).some(key => !["version", "session_id", "handler_hash", "request_id", "response"].includes(key))
      || decoded.version !== 1 || decoded.session_id !== pairing.session_id || decoded.handler_hash !== this.handlerHash || decoded.request_id !== requestId) {
      throw new NativeFusionError("INVALID_ADDIN_RESULT", "The signed add-in response does not match this session, request and reviewed handler.");
    }
    const result = validateDesktopResponse(decoded.response);
    if (!response.ok && result.ok) throw new NativeFusionError("INVALID_ADDIN_RESULT", "An HTTP error cannot certify desktop success.");
    return result;
  }
}
