"""Fusion add-in entry point. Install the assembled dist/addin package only.

References:
https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Threading_UM.htm
https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/CustomEventSample_Sample.htm
https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/WritingDebugging_UM.htm
"""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types
import uuid

from .bridge import Bridge


_state = {}


def _read_package_file(filename, maximum):
    path = Path(filename)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_size > maximum or getattr(before, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("Add-in package file is missing, oversized or linked")
    descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("Add-in package file changed during access")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise RuntimeError("Add-in package file is oversized")
        return data


def _configuration(root):
    if os.name == "nt":
        state_root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "CodexFusion" / "addin"
    else:
        state_root = Path.home() / ".local" / "state" / "codex-fusion" / "addin"
    config = {"port": 27183, "tokenFile": str(state_root / "session.json"), "timeoutMs": 30000, "maxQueue": 16}
    filename = root / "config.json"
    if filename.exists() or filename.is_symlink():
        values = json.loads(_read_package_file(filename, 4096).decode("utf-8"))
        if not isinstance(values, dict) or set(values) - set(config):
            raise RuntimeError("Unknown add-in configuration fields")
        config.update(values)
    if type(config["port"]) is not int or not 1 <= config["port"] <= 65535:
        raise RuntimeError("Configure one explicit add-in port from 1 through 65535")
    if type(config["timeoutMs"]) is not int or not 100 <= config["timeoutMs"] <= 120000:
        raise RuntimeError("Add-in timeout must be between 100 and 120000 milliseconds")
    if type(config["maxQueue"]) is not int or not 1 <= config["maxQueue"] <= 32:
        raise RuntimeError("Add-in queue must contain between 1 and 32 requests")
    if not isinstance(config["tokenFile"], str) or not Path(config["tokenFile"]).is_absolute() or config["tokenFile"].startswith(("\\\\", "//")):
        raise RuntimeError("Add-in tokenFile must be an absolute private local path")
    return config


def _load_reviewed_handler(root):
    manifest = json.loads(_read_package_file(root / "handler-manifest.json", 4096).decode("utf-8"))
    if (not isinstance(manifest, dict) or set(manifest) != {"version", "handler_file", "handler_hash"} or manifest["version"] != 1
            or manifest["handler_file"] != "fusion_runtime.py" or not isinstance(manifest["handler_hash"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", manifest["handler_hash"])):
        raise RuntimeError("The assembled add-in handler manifest is invalid")
    source_path = root / "fusion_runtime.py"
    source = _read_package_file(source_path, 2 * 1024 * 1024)
    if hashlib.sha256(source).hexdigest() != manifest["handler_hash"]:
        raise RuntimeError("The installed reviewed handler hash does not match its package manifest")
    # A fresh handler module gives each add-in start its own session/handle
    # namespace. Source is read once, verified, then compiled from those bytes.
    name = "_codex_fusion_addin_handler_" + uuid.uuid4().hex
    module = types.ModuleType(name)
    module.__file__ = str(source_path)
    sys.modules[name] = module
    try:
        exec(compile(source, str(source_path), "exec"), module.__dict__)
        if not callable(getattr(module, "dispatch", None)):
            raise RuntimeError("Reviewed handler has no typed dispatch function")
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module, manifest["handler_hash"]


def run(context):
    if _state:
        return
    # adsk and every API object stay in the main-thread lifecycle. The sole
    # worker exception is Autodesk's documented fireCustomEvent method.
    import adsk.core
    app = adsk.core.Application.get()
    event = None
    bridge = None
    module = None
    event_id = "community.codex.fusion.interop." + uuid.uuid4().hex
    handler = None
    try:
        root = Path(__file__).resolve().parent
        config = _configuration(root)
        module, handler_hash = _load_reviewed_handler(root)
        event = app.registerCustomEvent(event_id)
        if event is None:
            raise RuntimeError("Fusion custom event registration failed")

        class _DispatchEvent(adsk.core.CustomEventHandler):
            def notify(self, args):
                key = args.additionalInfo
                if isinstance(key, str) and re.fullmatch(r"[a-f0-9]{32}", key):
                    active = _state.get("bridge")
                    if active is not None:
                        active.dispatch_on_main_thread(key)

        handler = _DispatchEvent()
        if event.add(handler) is False:
            raise RuntimeError("Fusion custom event handler registration failed")
        bridge = Bridge(module.dispatch, handler_hash, lambda key: app.fireCustomEvent(event_id, key),
            config["tokenFile"], port=config["port"], timeout_seconds=config["timeoutMs"] / 1000, max_queue=config["maxQueue"])
        _state.update({"app": app, "event": event, "handler": handler, "event_id": event_id, "bridge": bridge, "module": module})
        bridge.start()
    except BaseException:
        if bridge is not None:
            bridge.stop()
        if event is not None and handler is not None:
            event.remove(handler)
        if event is not None:
            app.unregisterCustomEvent(event_id)
        if module is not None:
            sys.modules.pop(module.__name__, None)
        _state.clear()
        app.userInterface.messageBox("Codex Fusion interoperability could not start. Verify the assembled add-in, selected port and private pairing-file permissions. No desktop operation was executed.")


def stop(context):
    if not _state:
        return
    state = dict(_state)
    _state.clear()
    try:
        state["bridge"].stop()
    finally:
        try:
            state["event"].remove(state["handler"])
        finally:
            state["app"].unregisterCustomEvent(state["event_id"])
            sys.modules.pop(state["module"].__name__, None)
