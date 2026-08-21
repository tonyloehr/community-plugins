"""Bounded real-PTY driver for one disposable shipped Grafana CLI profile.

The token arrives only on the driver's private stdin pipe, never argv or env.
No transcript is emitted if it contains the token. Terminal echo must be off
before any input is sent, and restored when the real CLI exits.
"""

import base64
import errno
import fcntl
import json
import os
import re
import select
import signal
import subprocess
import sys
import termios
import time
from urllib.parse import urlsplit

phase = "input"


def run():
    global phase
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("Driver input exceeded its bound")
    config = json.loads(raw)
    if set(config) - {"nodeExecutable", "pluginRoot", "mode", "profileAlias", "origin", "secretBase64"}:
        raise RuntimeError("Driver input has unexpected fields")
    mode = config.get("mode")
    alias = config.get("profileAlias", "")
    if mode not in ("connect", "status", "delete") or not re.fullmatch(r"community-native-handoff-[0-9a-f-]{36}", alias):
        raise RuntimeError("Driver operation is not a disposable profile action")
    node = config.get("nodeExecutable", "")
    plugin = config.get("pluginRoot", "")
    if not os.path.isabs(node) or not os.path.isabs(plugin):
        raise RuntimeError("Driver paths must be absolute")
    arguments = [node, os.path.join(plugin, "scripts", "observabilityctl.mjs"), "grafana", mode]
    secret = bytearray()
    steps = []
    if mode == "connect":
        origin = config.get("origin", "")
        url = urlsplit(origin)
        if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
                or url.path not in ("", "/") or url.query or url.fragment or url.username or url.password):
            raise RuntimeError("Driver only admits the explicit disposable loopback origin")
        secret = bytearray(base64.b64decode(config.get("secretBase64", ""), validate=True))
        if not 1 <= len(secret) <= 16384 or any(value < 33 or value > 126 for value in secret):
            raise RuntimeError("Driver secret is invalid")
        arguments += ["--url", origin]
        steps = [(b"Grafana bearer token: ", secret), (b"Type ACTIVATE to connect: ", b"ACTIVATE")]
    elif "origin" in config or "secretBase64" in config:
        raise RuntimeError("Unexpected connection input for a non-connect operation")
    if mode == "delete":
        steps = [(b"Type DELETE to continue: ", b"DELETE")]
    arguments += ["--profile", alias, "--json"]
    config.pop("secretBase64", None)
    raw = b""
    master, slave = os.openpty()
    child = None
    transcript = bytearray()
    consumed = 0
    search_start = 0
    raw_verified = []
    echo_restored = False
    deadline = time.monotonic() + 60

    def session():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    try:
        phase = "launch"
        child = subprocess.Popen(arguments, cwd=plugin, stdin=slave, stdout=slave, stderr=slave,
                                 close_fds=True, preexec_fn=session)
        phase = "terminal"
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError("Real CLI exceeded the PTY deadline")
            if consumed < len(steps):
                prompt, value = steps[consumed]
                position = transcript.find(prompt, search_start)
                if position >= 0:
                    flags = termios.tcgetattr(slave)[3]
                    if not flags & (termios.ECHO | termios.ICANON):
                        raw_verified.append(True)
                        packet = bytearray(value) + b"\n"
                        try:
                            sent = 0
                            while sent < len(packet):
                                sent += os.write(master, packet[sent:])
                        finally:
                            packet[:] = b"\x00" * len(packet)
                        consumed += 1
                        search_start = position + len(prompt)
            try:
                flags = termios.tcgetattr(slave)[3]
                if consumed == len(steps) and flags & termios.ECHO and flags & termios.ICANON:
                    echo_restored = True
            except (OSError, termios.error):
                # A controlling PTY may hang up immediately after process exit.
                # Only restoration actually observed after the last input counts.
                pass
            ready, _, _ = select.select([master], [], [], 0.02)
            terminal_eof = False
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                terminal_eof = not chunk
                if chunk:
                    transcript.extend(chunk)
                    if len(transcript) > 131072:
                        raise RuntimeError("Real CLI exceeded the PTY transcript bound")
            if child.poll() is not None and (not ready or terminal_eof):
                break
        if secret and secret in transcript:
            raise RuntimeError("Real CLI exposed the disposable credential; transcript withheld")
        phase = "terminal-restoration"
        try:
            flags = termios.tcgetattr(slave)[3]
            echo_restored = bool(flags & termios.ECHO and flags & termios.ICANON)
        except (OSError, termios.error):
            pass
        return {"exitCode": child.returncode, "consumedInputs": consumed,
                "rawInputVerified": raw_verified,
                "echoRestored": echo_restored,
                "transcript": transcript.decode("utf-8", errors="strict")}
    finally:
        secret[:] = b"\x00" * len(secret)
        transcript[:] = b"\x00" * len(transcript)
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
        os.close(master)
        os.close(slave)


try:
    print(json.dumps(run(), separators=(",", ":")))
except Exception as error:
    # Exception details and locals may contain input; publish only this constant.
    print(json.dumps({"driverError": "Real PTY qualification failed; subprocess details withheld",
                      "phase": phase, "exceptionType": type(error).__name__}))
    sys.exit(1)
