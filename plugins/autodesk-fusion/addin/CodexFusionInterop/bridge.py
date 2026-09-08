"""Typed, authenticated loopback IPC for the optional Fusion add-in.

No adsk imports or API objects belong in this module. HTTP workers may call the
provided fire-event callback only. The retained main-thread event handler calls
dispatch_on_main_thread; only that method invokes the reviewed desktop handler.
"""

import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
from pathlib import Path
import re
import secrets
import socket
from socketserver import TCPServer, ThreadingMixIn
import threading
import time

from .private_storage import remove_session_file, write_private_json


READ_OPERATIONS = frozenset(("documents.list", "document.inspect", "parameters.list", "entities.find",
    "geometry.measure", "geometry.check", "configurations.list", "materials.list", "render.status", "cam.inspect", "cam.status",
    "bom.inspect", "cam.setup_schema", "cam.operation_schema", "cam.tools_list", "cam.machining_time"))
_MAX_REQUEST_BYTES = 2 * 1024 * 1024
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_RECORDS = 1024
_MAX_CACHED_BYTES = 8 * 1024 * 1024


def failure(code, message, outcome="none"):
    return {"ok": False, "error": {"code": code, "message": message, "outcome": outcome}}


def _json_bytes(value, limit):
    encoded = []
    length = 0
    for part in json.JSONEncoder(ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True).iterencode(value):
        part = part.encode("ascii")
        length += len(part)
        if length > limit:
            raise ValueError("JSON size limit exceeded")
        encoded.append(part)
    return b"".join(encoded)


def _bounded_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON keys")
            result[key] = value
        return result

    def bad_number(_value):
        raise ValueError("Non-finite JSON number")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=bad_number)
    nodes = [0]
    def visit(item, depth):
        nodes[0] += 1
        if nodes[0] > 30000 or depth > 40:
            raise ValueError("JSON complexity limit exceeded")
        if isinstance(item, dict):
            for key, child in item.items():
                if len(key) > 2048:
                    raise ValueError("JSON key limit exceeded")
                visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Non-finite JSON number")
    visit(value, 0)
    return value


def _valid_request(request):
    if not isinstance(request, dict) or set(request) - {"operation", "args", "request_id", "document_id", "expected_state"}:
        raise ValueError("Invalid desktop request fields")
    if not isinstance(request.get("operation"), str) or not re.fullmatch(r"[a-z][a-z0-9._]{0,127}", request["operation"]):
        raise ValueError("Invalid desktop operation")
    if not isinstance(request.get("args"), dict):
        raise ValueError("Desktop arguments must be an object")
    request_id = request.get("request_id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 256 or re.search(r"[\x00-\x1f\x7f]", request_id):
        raise ValueError("Invalid desktop request ID")
    for field in ("document_id", "expected_state"):
        if field in request and (not isinstance(request[field], str) or not request[field] or len(request[field]) > 2048 or re.search(r"[\x00-\x1f\x7f]", request[field])):
            raise ValueError("Invalid document or state reference")
    return request


def sign_request(token, method, session_id, nonce, timestamp, body):
    prefix = "request\n%s\n/dispatch\n%s\n%s\n%s\n" % (method, session_id, nonce, timestamp)
    return hmac.new(bytes.fromhex(token), prefix.encode("ascii") + body, hashlib.sha256).hexdigest()


def sign_response(token, nonce, status, body):
    return hmac.new(bytes.fromhex(token), ("response\n%s\n%s\n" % (nonce, status)).encode("ascii") + body, hashlib.sha256).hexdigest()


class _Pending:
    def __init__(self, request, deadline):
        self.key = secrets.token_hex(16)
        self.request = request
        self.request_id = request["request_id"]
        self.request_hash = hashlib.sha256(_json_bytes(request, _MAX_REQUEST_BYTES)).hexdigest()
        self.deadline = deadline
        self.mutation = request["operation"] not in READ_OPERATIONS
        self.started = False
        self.cancelled = False
        self.result = None
        self.result_bytes = 0
        self.done = threading.Event()


class _LimitedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False
    request_queue_size = 16

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # HTTPServer resolves its address with getfqdn while binding. This
        # numeric loopback endpoint must start even when host DNS is stalled.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def process_request(self, request, client_address):
        if not self.bridge._http_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.bridge._http_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.bridge._http_slots.release()

    def handle_error(self, request, client_address):
        # No caller content, credentials, paths or Python traceback in logs.
        pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CodexFusionInterop/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, _format, *args):
        pass

    def handle_expect_100(self):
        self._reply(417, failure("INVALID_HTTP_REQUEST", "Expect headers are not supported"))
        return False

    def _one(self, name):
        values = self.headers.get_all(name, [])
        return values[0] if len(values) == 1 else None

    def _reply(self, status, result, nonce=None, request_id=None):
        bridge = self.server.bridge
        envelope = {"version": 1, "session_id": bridge.session_id, "handler_hash": bridge.handler_hash,
                    "request_id": request_id, "response": result}
        try:
            body = _json_bytes(envelope, _MAX_RESPONSE_BYTES)
        except (ValueError, TypeError, RecursionError):
            envelope["response"] = failure("OUTCOME_UNKNOWN", "The add-in could not return a bounded verifiable result", "unknown")
            body = _json_bytes(envelope, _MAX_RESPONSE_BYTES)
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if nonce and re.fullmatch(r"[a-f0-9]{48}", nonce):
                self.send_header("X-Codex-Fusion-Signature", sign_response(bridge.token, nonce, status, body))
            self.end_headers()
            self.wfile.write(body)
        except (OSError, ConnectionError):
            # A lost reply does not mean a queued/running operation was undone.
            pass

    def _handle(self, method):
        bridge = self.server.bridge
        if self.path != "/dispatch" or self.client_address[0] != "127.0.0.1":
            self._reply(404, failure("INVALID_ENDPOINT", "Only the configured loopback dispatch endpoint is available"))
            return
        if sum(len(key) + len(value) for key, value in self.headers.items()) > 16384:
            self._reply(431, failure("INVALID_HTTP_REQUEST", "Request headers exceed their limit"))
            return
        hosts = {"127.0.0.1:%s" % bridge.port}
        if bridge.port == 80:
            hosts.add("127.0.0.1")
        if self._one("Host") not in hosts or self.headers.get_all("Origin") is not None or any(key.lower().startswith("sec-fetch-") for key in self.headers):
            self._reply(403, failure("BROWSER_OR_HOST_DENIED", "Browser requests and unconfigured Host headers are refused"))
            return
        if self.headers.get_all("Transfer-Encoding") is not None or self.headers.get_all("Content-Encoding") is not None:
            self._reply(415, failure("INVALID_HTTP_REQUEST", "Transfer and content encodings are not supported"))
            return
        body = b""
        if method == "POST":
            length = self._one("Content-Length")
            content_type = self._one("Content-Type")
            if length is None or not re.fullmatch(r"[0-9]{1,9}", length) or not 0 < int(length) <= _MAX_REQUEST_BYTES:
                self._reply(413, failure("INVALID_HTTP_REQUEST", "A bounded Content-Length is required"))
                return
            if content_type not in ("application/json", "application/json; charset=utf-8"):
                self._reply(415, failure("INVALID_HTTP_REQUEST", "JSON content type is required"))
                return
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                self._reply(400, failure("INVALID_HTTP_REQUEST", "The JSON body was incomplete"))
                return
        elif self.headers.get_all("Content-Length") is not None and self._one("Content-Length") != "0":
            self._reply(400, failure("INVALID_HTTP_REQUEST", "GET cannot carry a request body"))
            return
        nonce = self._one("X-Codex-Fusion-Nonce")
        timestamp = self._one("X-Codex-Fusion-Timestamp")
        session_id = self._one("X-Codex-Fusion-Session")
        signature = self._one("X-Codex-Fusion-Signature")
        if (nonce is None or not re.fullmatch(r"[a-f0-9]{48}", nonce) or timestamp is None or not re.fullmatch(r"[0-9]{10,12}", timestamp)
                or signature is None or not re.fullmatch(r"[a-f0-9]{64}", signature) or session_id != bridge.session_id
                or not -15 <= time.time() - int(timestamp) <= 60
                or not hmac.compare_digest(signature, sign_request(bridge.token, method, session_id, nonce, timestamp, body))):
            self._reply(401, failure("AUTHENTICATION_FAILED", "The local add-in request could not be authenticated"))
            return
        with bridge._lock:
            now = time.monotonic()
            bridge._nonces = {key: seen for key, seen in bridge._nonces.items() if now - seen < 90}
            if nonce in bridge._nonces or len(bridge._nonces) >= 4096:
                self._reply(409, failure("REPLAY_DENIED", "Request replay or replay-window capacity limit"), nonce)
                return
            bridge._nonces[nonce] = now
            if bridge._stopped:
                self._reply(503, failure("ADDIN_STOPPED", "The Fusion add-in is stopping"), nonce)
                return
        if method == "GET":
            self._reply(200, {"ok": True, "data": {"provider": "addin", "session_id": bridge.session_id,
                "handler_hash": bridge.handler_hash, "threading": "custom_event_main_thread", "live_qualification": "not_inferred"}}, nonce)
            return
        try:
            envelope = _bounded_json(body)
            if (not isinstance(envelope, dict) or set(envelope) != {"version", "session_id", "handler_hash", "request"}
                    or envelope["version"] != 1 or envelope["session_id"] != bridge.session_id or envelope["handler_hash"] != bridge.handler_hash):
                raise ValueError("Version, session or handler mismatch")
            request = _valid_request(envelope["request"])
        except (ValueError, TypeError, RecursionError, UnicodeError):
            self._reply(400, failure("INVALID_REQUEST", "The versioned typed add-in request was rejected before execution"), nonce)
            return
        result = bridge.submit(request)
        self._reply(200, result, nonce, request["request_id"])

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_OPTIONS(self):
        self._reply(403, failure("BROWSER_OR_HOST_DENIED", "Browser preflight is not supported"))

    def do_PUT(self):
        self._reply(405, failure("INVALID_HTTP_REQUEST", "Unsupported method"))

    do_DELETE = do_PUT
    do_PATCH = do_PUT


class Bridge:
    def __init__(self, dispatch, handler_hash, fire_event, token_file, port=27183, timeout_seconds=30, max_queue=16):
        if not callable(dispatch) or not callable(fire_event) or not re.fullmatch(r"[a-f0-9]{64}", handler_hash):
            raise ValueError("A reviewed dispatcher, source hash and event callback are required")
        if type(port) is not int or not 0 <= port <= 65535 or not 0.05 <= timeout_seconds <= 120 or type(max_queue) is not int or not 1 <= max_queue <= 32:
            raise ValueError("Invalid bounded bridge configuration")
        # Port zero is useful only to allocate one fixture socket. The installed
        # add-in's configuration rejects zero and always selects an explicit port.
        self.handler_hash = handler_hash
        self.session_id = "fusion_addin_" + secrets.token_hex(16)
        self.token = secrets.token_hex(32)
        self.token_file = Path(token_file)
        self._dispatch = dispatch
        self._fire_event = fire_event
        self._owner_thread = threading.current_thread()
        self._timeout = timeout_seconds
        self._max_queue = max_queue
        self._lock = threading.RLock()
        self._http_slots = threading.BoundedSemaphore(32)
        self._pending = {}
        self._records = {}
        self._record_bytes = 0
        self._nonces = {}
        self._stopped = False
        self._server = _LimitedServer(("127.0.0.1", port), _Handler)
        self._server.bridge = self
        self.port = self._server.server_address[1]
        self.url = "http://127.0.0.1:%s/dispatch" % self.port
        self._thread = threading.Thread(target=lambda: self._server.serve_forever(poll_interval=0.1), name="codex-fusion-http", daemon=True)

    def start(self):
        if self._thread.is_alive() or self._stopped:
            raise RuntimeError("Bridge cannot be started twice")
        try:
            write_private_json(self.token_file, {"version": 1, "url": self.url, "token": self.token,
                "session_id": self.session_id, "handler_hash": self.handler_hash})
            self._thread.start()
        except BaseException:
            self._server.server_close()
            self._stopped = True
            remove_session_file(self.token_file, self.session_id)
            raise

    def submit(self, request):
        request = _valid_request(request)
        candidate = _Pending(request, time.monotonic() + self._timeout)
        with self._lock:
            if self._stopped:
                return failure("ADDIN_STOPPED", "The Fusion add-in has stopped")
            prior = self._records.get(request["request_id"])
            if prior:
                if prior.request_hash != candidate.request_hash:
                    return failure("IDEMPOTENCY_CONFLICT", "A request ID cannot be reused for different desktop input")
                if prior.done.is_set():
                    return prior.result or failure("OUTCOME_UNKNOWN", "The result was evicted; inspect Fusion before retrying this operation", "unknown")
                pending = prior
                new = False
            else:
                if len(self._pending) >= self._max_queue or len(self._records) >= _MAX_RECORDS:
                    return failure("SESSION_BUSY", "The bounded add-in queue or session ledger is full; finish and reconcile pending work")
                pending = candidate
                self._pending[pending.key] = pending
                self._records[request["request_id"]] = pending
                new = True
        if new:
            try:
                if not self._fire_event(pending.key):
                    raise RuntimeError("Event could not be enqueued")
            except BaseException:
                with self._lock:
                    if not pending.started:
                        pending.cancelled = True
                        self._complete(pending, failure("EVENT_UNAVAILABLE", "Fusion did not accept the main-thread event"))
        if not pending.done.wait(max(0, pending.deadline - time.monotonic())):
            with self._lock:
                if not pending.started:
                    pending.cancelled = True
                    self._complete(pending, failure("ADDIN_TIMEOUT", "The queued operation expired before main-thread execution"))
                else:
                    return failure("OUTCOME_UNKNOWN", "The main-thread operation may still be running; timeout is not rollback", "unknown")
        with self._lock:
            return pending.result or failure("OUTCOME_UNKNOWN", "No retained result is available; reconcile Fusion state", "unknown")

    def _complete(self, pending, result):
        # Caller holds _lock. JSON conversion removes API objects or shared
        # handler containers before the response crosses onto an I/O thread.
        try:
            encoded = _json_bytes(result, _MAX_RESPONSE_BYTES - 1024)
            copied = _bounded_json(encoded)
            if not isinstance(copied, dict) or type(copied.get("ok")) is not bool:
                raise ValueError("Invalid dispatcher result")
        except (ValueError, TypeError, RecursionError, UnicodeError):
            copied = failure("OUTCOME_UNKNOWN", "The reviewed handler returned an invalid or oversized result", "unknown")
            encoded = _json_bytes(copied, 4096)
        pending.result = copied
        pending.result_bytes = len(encoded)
        self._pending.pop(pending.key, None)
        pending.done.set()
        if not pending.mutation:
            self._records.pop(pending.request_id, None)
        else:
            self._record_bytes += pending.result_bytes
            for prior in self._records.values():
                if self._record_bytes <= _MAX_CACHED_BYTES:
                    break
                if prior is not pending and prior.done.is_set() and prior.result is not None:
                    self._record_bytes -= prior.result_bytes
                    prior.result = None
                    prior.result_bytes = 0
            # Tombstones retain the request hash after output eviction. An old
            # request is never executed again just because its result was large.
        # Completed ledgers retain only hashes/IDs and bounded result bytes,
        # never every historical megabyte-sized request argument object.
        pending.request = None

    def dispatch_on_main_thread(self, key):
        if threading.current_thread() is not self._owner_thread or threading.current_thread() is not threading.main_thread():
            raise RuntimeError("Only Fusion's main thread may dispatch desktop operations")
        with self._lock:
            pending = self._pending.get(key)
            if pending is None or pending.started or pending.done.is_set():
                return
            if self._stopped or pending.cancelled or time.monotonic() >= pending.deadline:
                self._complete(pending, failure("ADDIN_TIMEOUT", "The operation expired before main-thread execution"))
                return
            pending.started = True
        try:
            result = self._dispatch(pending.request)
        except BaseException:
            result = failure("OUTCOME_UNKNOWN", "The reviewed desktop handler failed during execution", "unknown")
        with self._lock:
            self._complete(pending, result)

    def stop(self):
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
            for pending in list(self._pending.values()):
                if not pending.started:
                    pending.cancelled = True
                    self._complete(pending, failure("ADDIN_STOPPED", "The add-in stopped before this operation started"))
        if self._thread.is_alive():
            self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1) if self._thread.ident is not None else None
        remove_session_file(self.token_file, self.session_id)
