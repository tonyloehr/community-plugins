import { createHash, randomBytes } from "node:crypto";
import type { DesktopRequest, DesktopResponse } from "./types.js";
import { boundedInteger, boundedJson, cloneNativeJson, DEFAULT_NATIVE_RESPONSE_BYTES, isRecord, NativeFusionError } from "./native-security.js";

const MAX_HANDLER_BYTES = 2 * 1024 * 1024;
const MAX_DESKTOP_REQUEST_BYTES = 2 * 1024 * 1024;
const MARKER_PATTERN = /^CODEX_FUSION_V1_[a-f0-9]{64}$/u;

export interface DesktopScript {
  script: string;
  marker: string;
  handlerHash: string;
  requestId: string;
}

export function validateDesktopRequest(value: DesktopRequest): DesktopRequest {
  const request = cloneNativeJson(value, MAX_DESKTOP_REQUEST_BYTES);
  if (!isRecord(request) || Object.keys(request).some(key => !["operation", "args", "request_id", "document_id", "expected_state"].includes(key))
    || typeof request.operation !== "string" || !/^[a-z][a-z0-9._]{0,127}$/u.test(request.operation)
    || !isRecord(request.args) || typeof request.request_id !== "string" || !request.request_id.length
    || request.request_id.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.request_id)) {
    throw new NativeFusionError("INVALID_REQUEST", "Desktop dispatch requires a typed operation, bounded JSON arguments, and a request ID.");
  }
  for (const field of ["document_id", "expected_state"] as const) {
    if (request[field] !== undefined && (typeof request[field] !== "string" || !request[field].length || request[field].length > 2048
      || /[\u0000-\u001f\u007f]/u.test(request[field]))) {
      throw new NativeFusionError("INVALID_REQUEST", "Desktop document and state references must be bounded nonempty strings.");
    }
  }
  return request;
}

/**
 * The trusted caller supplies installed, reviewed source, never model code.
 * All other values are base64-encoded JSON. The generated source runs once as
 * a script body; an enrolled native script tool must qualify that convention.
 * This is an interoperability wrapper, not a Python or OS sandbox.
 */
export function buildDesktopScript(handlerSource: string, request: DesktopRequest, options: {
  maxResponseBytes?: number;
} = {}): DesktopScript {
  if (typeof handlerSource !== "string" || !handlerSource.trim() || Buffer.byteLength(handlerSource) > MAX_HANDLER_BYTES) {
    throw new NativeFusionError("INVALID_HANDLER", "Configure a bounded, reviewed desktop handler module before managed execution.");
  }
  const clean = validateDesktopRequest(request);
  const outputLimit = boundedInteger(options.maxResponseBytes ?? DEFAULT_NATIVE_RESPONSE_BYTES, "maxResponseBytes", 512, 32 * 1024 * 1024);
  const marker = `CODEX_FUSION_V1_${randomBytes(32).toString("hex")}`;
  const source = Buffer.from(handlerSource, "utf8");
  const handlerHash = createHash("sha256").update(source).digest("hex");
  const failureEnvelope = JSON.stringify({ version: 1, request_id: clean.request_id, handler_hash: handlerHash,
    response: { ok: false, error: { code: "INVALID_HANDLER_RESULT", message: "The desktop result could not be serialized within its limit.", outcome: "unknown" } },
  }).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (Buffer.byteLength(failureEnvelope) > outputLimit) {
    throw new NativeFusionError("PAYLOAD_TOO_LARGE", "The request identity cannot fit inside the bounded desktop result envelope.");
  }
  const requestData = Buffer.from(boundedJson(clean, MAX_DESKTOP_REQUEST_BYTES), "utf8").toString("base64");
  // Every interpolated token below is generated locally from fixed literals,
  // bounded integers, a SHA-256, or base64. No request string becomes Python.
  const script = `def _codex_fusion_bridge_run():
    import base64 as _b64
    import contextlib as _contextlib
    import hashlib as _hashlib
    import json as _json
    import sys as _sys
    import types as _types

    _source_hash = "${handlerHash}"
    _source = _b64.b64decode("${source.toString("base64")}", validate=True)
    _request = _json.loads(_b64.b64decode("${requestData}", validate=True).decode("utf-8"))
    _marker = "${marker}"
    _limit = ${outputLimit}
    _module_name = "_codex_fusion_handler_" + _source_hash
    _output = _sys.stdout

    class _DiscardOutput:
        def write(self, value):
            return len(value)
        def flush(self):
            pass

    try:
        with _contextlib.redirect_stdout(_DiscardOutput()), _contextlib.redirect_stderr(_DiscardOutput()):
            if _hashlib.sha256(_source).hexdigest() != _source_hash:
                raise RuntimeError("Handler source hash mismatch")
            _module = _sys.modules.get(_module_name)
            if _module is None:
                _module = _types.ModuleType(_module_name)
                _module.__file__ = "<codex-fusion:" + _source_hash + ">"
                _sys.modules[_module_name] = _module
                try:
                    exec(compile(_source, _module.__file__, "exec"), _module.__dict__)
                    _module.__codex_handler_hash__ = _source_hash
                except BaseException:
                    if _sys.modules.get(_module_name) is _module:
                        del _sys.modules[_module_name]
                    raise
            elif not isinstance(_module, _types.ModuleType) or getattr(_module, "__codex_handler_hash__", None) != _source_hash:
                raise RuntimeError("Handler module cache mismatch")
            if not callable(getattr(_module, "dispatch", None)):
                raise RuntimeError("Handler dispatch is unavailable")
            _response = _module.dispatch(_request)
    except BaseException:
        _response = {"ok": False, "error": {"code": "HANDLER_FAILED", "message": "The reviewed desktop handler did not return a verifiable result.", "outcome": "unknown"}}

    def _encode_bounded(value):
        chunks = []
        size = 0
        for chunk in _json.JSONEncoder(ensure_ascii=True, allow_nan=False, separators=(",", ":")).iterencode(value):
            encoded = chunk.encode("ascii")
            size += len(encoded)
            if size > _limit:
                raise ValueError("Desktop response limit exceeded")
            chunks.append(encoded)
        return b"".join(chunks)

    _envelope = {"version": 1, "request_id": _request["request_id"], "handler_hash": _source_hash, "response": _response}
    try:
        _encoded = _encode_bounded(_envelope)
    except BaseException:
        _envelope["response"] = {"ok": False, "error": {"code": "INVALID_HANDLER_RESULT", "message": "The desktop result could not be serialized within its limit.", "outcome": "unknown"}}
        _encoded = _json.dumps(_envelope, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    _output.write(_marker + ":" + _b64.b64encode(_encoded).decode("ascii") + ":" + _marker + "\\n")
    _output.flush()

_codex_fusion_bridge_run()
del _codex_fusion_bridge_run
`;
  return { script, marker, handlerHash, requestId: clean.request_id };
}

export function validateDesktopResponse(value: unknown): DesktopResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new NativeFusionError("INVALID_NATIVE_RESULT", "The native result does not match the desktop response contract.");
  }
  if (value.ok) {
    if (!Object.hasOwn(value, "data") || Object.keys(value).some(key => !["ok", "data", "state", "effects"].includes(key))
      || (value.state !== undefined && (typeof value.state !== "string" || value.state.length > 2048))
      || (value.effects !== undefined && (!Array.isArray(value.effects) || value.effects.length > 128 || value.effects.some(effect => typeof effect !== "string" || effect.length > 4096)))) {
      throw new NativeFusionError("INVALID_NATIVE_RESULT", "The native success response has invalid fields.");
    }
  } else {
    if (Object.keys(value).some(key => !["ok", "error"].includes(key)) || !isRecord(value.error)
      || Object.keys(value.error).some(key => !["code", "message", "details", "outcome"].includes(key))
      || typeof value.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.error.code)
      || typeof value.error.message !== "string" || value.error.message.length > 4096
      || (value.error.outcome !== undefined && !["none", "partial", "unknown"].includes(String(value.error.outcome)))) {
      throw new NativeFusionError("INVALID_NATIVE_RESULT", "The native error response has invalid fields.");
    }
  }
  return value as unknown as DesktopResponse;
}

/**
 * Parse only a complete, nonce-bound envelope in textual tool output. A bare
 * success object, tool prose, image, resource link, or old envelope is never
 * execution evidence. Mirrored text/structured output may repeat one identical
 * envelope; conflicting results are rejected. No resource URL is fetched.
 */
export function parseDesktopResult(result: unknown, marker: string, maxResponseBytes = DEFAULT_NATIVE_RESPONSE_BYTES, expected?: {
  requestId: string;
  handlerHash: string;
}): DesktopResponse {
  if (!MARKER_PATTERN.test(marker)) throw new NativeFusionError("INVALID_NATIVE_RESULT", "Invalid desktop response marker.");
  boundedInteger(maxResponseBytes, "maxResponseBytes", 512, 32 * 1024 * 1024);
  const clean = cloneNativeJson(result, maxResponseBytes);
  if (!isRecord(clean) || clean.isError === true) {
    throw new NativeFusionError("NATIVE_TOOL_ERROR", "The native MCP tool reported a failure; execution outcome requires reconciliation.");
  }
  const envelopes = new Set<string>();
  const pattern = new RegExp(`(?:^|\\r?\\n)${marker}:([A-Za-z0-9+/=]+):${marker}(?=\\r?\\n|$)`, "gu");
  let visited = 0;
  let matches = 0;
  let scannedBytes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++visited > 20_000 || depth > 32) throw new NativeFusionError("PAYLOAD_TOO_COMPLEX", "Native output nesting exceeds its limit.");
    if (typeof value === "string") {
      scannedBytes += Buffer.byteLength(value);
      if (scannedBytes > maxResponseBytes * 2) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native output nesting exceeds its byte limit.");
      for (const match of value.matchAll(pattern)) {
        if (++matches > 8) throw new NativeFusionError("INVALID_NATIVE_RESULT", "The native tool returned too many result envelopes.");
        envelopes.add(match[1]!);
      }
      // Some native script tools wrap stdout in JSON inside a text block.
      // Decode only whole JSON objects/arrays, never arbitrary escape fragments.
      const trimmed = value.trim();
      if (depth < 4 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
        let nested: unknown;
        try { nested = JSON.parse(trimmed); } catch { return; }
        visit(nested, depth + 1);
      }
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else if (isRecord(value)) {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  if (Array.isArray(clean.content)) {
    for (const block of clean.content) if (isRecord(block) && block.type === "text" && typeof block.text === "string") visit(block.text, 0);
  }
  if (Object.hasOwn(clean, "structuredContent")) visit(clean.structuredContent, 0);
  if (envelopes.size !== 1) {
    throw new NativeFusionError("INVALID_NATIVE_RESULT", envelopes.size ? "Conflicting desktop result envelopes were returned." : "No matching desktop result envelope was returned.");
  }
  const encoded = [...envelopes][0]!;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new NativeFusionError("INVALID_NATIVE_RESULT", "The desktop result envelope is not canonical base64.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maxResponseBytes || bytes.toString("base64") !== encoded) {
    throw new NativeFusionError("INVALID_NATIVE_RESULT", "The desktop result envelope exceeds its limit or has invalid encoding.");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new NativeFusionError("INVALID_NATIVE_RESULT", "The desktop result envelope is not valid UTF-8 JSON."); }
  envelope = cloneNativeJson(envelope, maxResponseBytes);
  if (!isRecord(envelope) || envelope.version !== 1
    || Object.keys(envelope).some(key => !["version", "request_id", "handler_hash", "response"].includes(key))
    || typeof envelope.request_id !== "string" || !envelope.request_id.length || envelope.request_id.length > 256
    || typeof envelope.handler_hash !== "string" || !/^[a-f0-9]{64}$/u.test(envelope.handler_hash)
    || (expected && (envelope.request_id !== expected.requestId || envelope.handler_hash !== expected.handlerHash))) {
    throw new NativeFusionError("INVALID_NATIVE_RESULT", "The desktop result envelope has an invalid version, request identity, or handler hash.");
  }
  return validateDesktopResponse(envelope.response);
}
