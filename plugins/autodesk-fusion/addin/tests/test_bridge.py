"""Threading, queue, replay and package-lifecycle doubles; no Fusion claim."""

import hashlib
import json
from pathlib import Path
import queue
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from CodexFusionInterop.bridge import Bridge, failure
from CodexFusionInterop import CodexFusionInterop as entry
from CodexFusionInterop.private_storage import read_private_json, write_private_json, remove_session_file


def request(identity="one", operation="parameters.modify", args=None):
    return {"operation": operation, "args": args or {}, "request_id": identity}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.events = queue.Queue()
        self.calls = []
        self.bridge = None

    def tearDown(self):
        if self.bridge:
            self.bridge.stop()
        self.temp.cleanup()

    def create(self, **options):
        def dispatch(value):
            self.calls.append((value, threading.current_thread()))
            return {"ok": True, "data": {"count": len(self.calls)}}
        def fire(key):
            self.events.put(key)
            return True
        self.bridge = Bridge(dispatch, "a" * 64, fire, self.root / "private" / "session.json", port=0, **options)
        self.bridge.start()
        return self.bridge

    def submit(self, value):
        result = []
        worker = threading.Thread(target=lambda: result.append(self.bridge.submit(value)))
        worker.start()
        return worker, result

    def test_workers_only_enqueue_and_main_thread_dispatches_once(self):
        bridge = self.create()
        worker, result = self.submit(request())
        key = self.events.get(timeout=1)
        self.assertEqual(self.calls, [])
        bridge.dispatch_on_main_thread(key)
        bridge.dispatch_on_main_thread(key)
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result[0]["data"]["count"], 1)
        self.assertIs(self.calls[0][1], threading.main_thread())
        self.assertIsNone(bridge._records["one"].request, "completed input must not accumulate in the ledger")
        again = bridge.submit(request())
        self.assertEqual(again["data"]["count"], 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(bridge.submit(request(args={"changed": True}))["error"]["code"], "IDEMPOTENCY_CONFLICT")

    def test_wrong_thread_cannot_execute_handler(self):
        bridge = self.create()
        worker, result = self.submit(request())
        key = self.events.get(timeout=1)
        errors = []
        def wrong():
            try:
                bridge.dispatch_on_main_thread(key)
            except RuntimeError as error:
                errors.append(str(error))
        thread = threading.Thread(target=wrong)
        thread.start()
        thread.join(1)
        self.assertEqual(len(errors), 1)
        self.assertEqual(self.calls, [])
        bridge.dispatch_on_main_thread(key)
        worker.join(1)
        self.assertTrue(result[0]["ok"])

    def test_queued_timeout_never_executes_late(self):
        bridge = self.create(timeout_seconds=0.05)
        worker, result = self.submit(request())
        key = self.events.get(timeout=1)
        worker.join(1)
        self.assertEqual(result[0]["error"]["outcome"], "none")
        bridge.dispatch_on_main_thread(key)
        self.assertEqual(self.calls, [])

    def test_running_timeout_is_unknown_then_reconciles_without_reexecution(self):
        bridge = self.create(timeout_seconds=0.05)
        original = bridge._dispatch
        def slow(value):
            time.sleep(0.1)
            return original(value)
        bridge._dispatch = slow
        worker, result = self.submit(request())
        bridge.dispatch_on_main_thread(self.events.get(timeout=1))
        worker.join(1)
        self.assertEqual(result[0]["error"]["outcome"], "unknown")
        self.assertEqual(bridge.submit(request())["data"]["count"], 1)
        self.assertEqual(len(self.calls), 1)

    def test_queue_full_and_stop_reject_without_mutations(self):
        bridge = self.create(max_queue=1)
        worker, result = self.submit(request())
        key = self.events.get(timeout=1)
        self.assertEqual(bridge.submit(request("second"))["error"]["code"], "SESSION_BUSY")
        bridge.stop()
        worker.join(1)
        self.assertEqual(result[0]["error"]["outcome"], "none")
        bridge.dispatch_on_main_thread(key)
        self.assertEqual(self.calls, [])
        self.assertFalse(bridge.token_file.exists())

    def test_event_failure_has_no_effect_and_does_not_leave_a_pending_request(self):
        bridge = self.create()
        bridge._fire_event = lambda _key: False
        self.assertEqual(bridge.submit(request())["error"]["code"], "EVENT_UNAVAILABLE")
        self.assertFalse(bridge._pending)
        self.assertEqual(self.calls, [])

    def test_handler_exception_is_unknown_and_details_are_not_leaked(self):
        bridge = self.create()
        def broken(_request):
            raise ValueError("SECRET_PATH_MUST_NOT_LEAK")
        bridge._dispatch = broken
        worker, result = self.submit(request())
        bridge.dispatch_on_main_thread(self.events.get(timeout=1))
        worker.join(1)
        self.assertEqual(result[0]["error"]["outcome"], "unknown")
        self.assertNotIn("SECRET_PATH", json.dumps(result))

    def test_read_results_do_not_exhaust_mutation_ledger(self):
        bridge = self.create()
        for i in range(8):
            worker, result = self.submit(request(str(i), "documents.list"))
            bridge.dispatch_on_main_thread(self.events.get(timeout=1))
            worker.join(1)
            self.assertTrue(result[0]["ok"])
        self.assertFalse(bridge._records)

    def test_private_pairing_storage_refuses_shared_or_linked_files(self):
        file = self.root / "safe" / "session.json"
        write_private_json(file, {"session_id": "this-session"})
        self.assertEqual(read_private_json(file)["session_id"], "this-session")
        remove_session_file(file, "different-session")
        self.assertTrue(file.exists())
        remove_session_file(file, "this-session")
        self.assertFalse(file.exists())
        if sys.platform != "win32":
            write_private_json(file, {"secret": "not-reported"})
            file.chmod(0o644)
            with self.assertRaises(RuntimeError):
                read_private_json(file)
            with self.assertRaises(RuntimeError):
                write_private_json(file, {"new": "not-written"})
            file.chmod(0o600)
            target = file.parent / "link.json"
            target.symlink_to(file)
            with self.assertRaises(RuntimeError):
                read_private_json(target)

    def test_loader_requires_assembled_hash_bound_handler_and_does_not_follow_links(self):
        package = self.root / "package"
        package.mkdir()
        source = b"def dispatch(request):\n    return {'ok': True, 'data': request['operation']}\n"
        handler = package / "fusion_runtime.py"
        handler.write_bytes(source)
        manifest = {"version": 1, "handler_file": "fusion_runtime.py", "handler_hash": hashlib.sha256(source).hexdigest()}
        (package / "handler-manifest.json").write_text(json.dumps(manifest))
        module, code_hash = entry._load_reviewed_handler(package)
        self.addCleanup(lambda: sys.modules.pop(module.__name__, None))
        self.assertEqual(module.dispatch(request())["data"], "parameters.modify")
        self.assertEqual(code_hash, manifest["handler_hash"])
        handler.write_bytes(source + b"# tampered\n")
        with self.assertRaises(RuntimeError):
            entry._load_reviewed_handler(package)
        manifest["handler_file"] = "../../arbitrary.py"
        (package / "handler-manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(RuntimeError):
            entry._load_reviewed_handler(package)

    def test_lifecycle_registers_retains_and_unregisters_custom_event(self):
        package = self.root / "package"
        package.mkdir()
        source = b"def dispatch(request):\n    return {'ok': True, 'data': 'offline'}\n"
        (package / "fusion_runtime.py").write_bytes(source)
        (package / "handler-manifest.json").write_text(json.dumps({"version": 1, "handler_file": "fusion_runtime.py", "handler_hash": hashlib.sha256(source).hexdigest()}))
        event = types.SimpleNamespace(add=lambda handler: handlers.append(handler) or True, remove=lambda handler: handlers.remove(handler))
        handlers = []
        unregistered = []
        messages = []
        app = types.SimpleNamespace(registerCustomEvent=lambda event_id: event, unregisterCustomEvent=lambda event_id: unregistered.append(event_id),
            fireCustomEvent=lambda event_id, data: True, userInterface=types.SimpleNamespace(messageBox=lambda message: messages.append(message)))
        core = types.ModuleType("adsk.core")
        core.Application = types.SimpleNamespace(get=lambda: app)
        core.CustomEventHandler = object
        adsk = types.ModuleType("adsk")
        adsk.core = core
        instances = []
        class FakeBridge:
            def __init__(self, *args, **kwargs):
                self.keys = []
                self.stopped = False
                instances.append(self)
            def start(self):
                pass
            def stop(self):
                self.stopped = True
            def dispatch_on_main_thread(self, key):
                self.keys.append(key)
        with patch.dict(sys.modules, {"adsk": adsk, "adsk.core": core}), patch.object(entry, "__file__", str(package / "CodexFusionInterop.py")), patch.object(entry, "Bridge", FakeBridge):
            entry.run({})
            self.assertEqual(len(handlers), 1)
            handlers[0].notify(types.SimpleNamespace(additionalInfo="a" * 32))
            self.assertEqual(instances[0].keys, ["a" * 32])
            entry.run({})
            self.assertEqual(len(instances), 1)
            entry.stop({})
            self.assertTrue(instances[0].stopped)
            self.assertFalse(handlers)
            self.assertEqual(len(unregistered), 1)
            self.assertFalse(entry._state)
            self.assertFalse(messages)


if __name__ == "__main__":
    unittest.main()
