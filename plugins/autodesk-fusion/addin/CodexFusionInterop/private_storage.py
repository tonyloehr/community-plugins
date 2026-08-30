"""Private local pairing storage. This is a same-OS-user trust boundary.

Windows ACL operations use a fixed PowerShell program and a path environment
variable, never interpolated command text or ExecutionPolicy bypass. A denied
ACL operation fails closed. Windows ACL behavior still needs live qualification.
"""

import base64
import json
import os
from pathlib import Path
import stat
import subprocess
import uuid


_VERIFY_WINDOWS_ACL = r"""
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
"""

_INITIALIZE_WINDOWS_DIRECTORY = r"""
$ErrorActionPreference = 'Stop'
$path = $env:CODEX_FUSION_PAIRING_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
$acl.AddAccessRule($rule)
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, 'None', 'Allow'))
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output 'PRIVATE'
"""


def _windows_acl(script, filename):
    system_root = os.environ.get("SystemRoot", "")
    if not os.path.isabs(system_root):
        raise RuntimeError("Cannot locate the Windows ACL utility")
    executable = str(Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
    environment = dict(os.environ)
    environment["CODEX_FUSION_PAIRING_PATH"] = str(filename)
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    result = subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                            env=environment, capture_output=True, timeout=15, check=False)
    if result.returncode or result.stdout.decode("utf-8", "replace").strip() != "PRIVATE":
        raise RuntimeError("Private Windows ACL verification failed; administrator review is required")


def _ordinary(path, directory=False):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("Pairing paths cannot be symbolic links or reparse points")
    if directory and not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Pairing directory must be a directory")
    if not directory and not stat.S_ISREG(info.st_mode):
        raise RuntimeError("Pairing file must be a regular file")
    if os.name == "nt":
        _windows_acl(_VERIFY_WINDOWS_ACL, path)
    elif info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Pairing storage must be owned by this user and inaccessible to group/others")
    return info


def ensure_private_directory(path):
    path = Path(path)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise RuntimeError("Pairing directory must be an absolute canonical path without links")
    if not path.exists():
        path.mkdir(parents=True, mode=0o700, exist_ok=False)
        if os.name == "nt":
            # No secret exists until this new directory's ACL is private.
            _windows_acl(_INITIALIZE_WINDOWS_DIRECTORY, path)
    _ordinary(path, directory=True)
    return path


def read_private_json(filename):
    path = Path(filename)
    if not path.is_absolute() or str(path.parent.resolve()) != str(path.parent):
        raise RuntimeError("Pairing directory must be an absolute canonical path without links")
    _ordinary(path.parent, directory=True)
    before = _ordinary(path)
    if before.st_size > 8192:
        raise RuntimeError("Pairing file exceeds its size limit")
    descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("Pairing file changed during access")
        data = stream.read(8193)
        if len(data) > 8192:
            raise RuntimeError("Pairing file exceeds its size limit")
        return json.loads(data.decode("utf-8"))


def write_private_json(filename, value):
    path = Path(filename)
    ensure_private_directory(path.parent)
    if path.exists() or path.is_symlink():
        _ordinary(path)
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    if len(encoded) > 8192:
        raise RuntimeError("Pairing file exceeds its size limit")
    temporary = path.parent / (".pairing-" + uuid.uuid4().hex + ".json")
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _ordinary(temporary)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def remove_session_file(filename, session_id):
    path = Path(filename)
    try:
        if read_private_json(path).get("session_id") == session_id:
            path.unlink()
    except (FileNotFoundError, RuntimeError, ValueError):
        # Never remove a replacement, unsafe path, or another session's file.
        pass
