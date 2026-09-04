"""
Command Runner Skill - Core Implementation
============================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```execute_command ...``` fenced code block, or a Python
dict, and execute the corresponding shell command using subprocess.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import shlex
import sys
from typing import Any, Dict, Optional, Union

from executor import AxleExecutor, ExecutionResponse, extract_json, getSequential

# ---------------------------------------------------------------------------
# Danger detection
# ---------------------------------------------------------------------------

# Patterns that indicate dangerous commands (case-insensitive regex).
_DANGEROUS_PATTERNS = [
    r"rm\s+-rf\s+/",
    r"rm\s+-rf\s+/\*",
    r"rm\s+-rf\s+~",
    r"rm\s+-rf\s+--no-preserve-root",
    r"dd\s+if=",
    r":\(\)\s*\{[^}]*\}",
    r"fork\s+bomb",
    r">\s+/dev/sda",
    r"mkfs\.",
    r"fdisk",
    r"format\s+[a-z]:",
    r"del\s+/f\s+/s\s+/q",
    r"rd\s+/s\s+/q",
    r"sudo\s+",
    r"su\s+-",
    r"chmod\s+777",
]


def _is_dangerous(command: str) -> Optional[str]:
    """Return the matched pattern if the command is dangerous, else None."""
    for pat in _DANGEROUS_PATTERNS:
        if re.search(pat, command, re.IGNORECASE):
            return pat
    return None


# ---------------------------------------------------------------------------
# Shell type mapping
# ---------------------------------------------------------------------------

# Map shelltype strings to (executable, command_flag) tuples.
# The command_flag is used to pass the command string to the shell executable.
_SHELL_TYPE_MAP = {
    "bash":       ("/bin/bash",      "-c"),
    "maccmd":     ("/bin/zsh",       "-c"),
    "windowsbat": ("cmd.exe",        "/c"),
    "windowsps":  ("powershell.exe", "-Command"),
}


def _detect_shelltype() -> str:
    """Auto-detect the appropriate shelltype based on sys.platform."""
    platform = sys.platform
    if platform.startswith("linux"):
        return "bash"
    elif platform == "darwin":
        return "maccmd"
    elif platform in ("win32", "cygwin", "msys"):
        return "windowsps"
    else:
        # Unknown platform – default to bash
        return "bash"


def _get_shell_command(shelltype: Optional[str], command: str) -> Optional[list]:
    """
    Build the argument list for running a command with an explicit shell.

    Args:
        shelltype: The shell type key (e.g. 'bash', 'windowsps') or None.
        command: The raw command string to execute.

    Returns:
        A list of arguments suitable for subprocess.run(shell=False),
        or None if no explicit shell should be used (fallback to old behavior).
    """
    if not shelltype:
        return None

    shelltype = shelltype.lower().strip()
    if shelltype not in _SHELL_TYPE_MAP:
        raise ValueError(
            f"Unsupported shelltype: {shelltype!r}. "
            f"Supported values: {', '.join(_SHELL_TYPE_MAP.keys())}"
        )

    exe, flag = _SHELL_TYPE_MAP[shelltype]
    return [exe, flag, command]


# ---------------------------------------------------------------------------
# Payload validation & normalisation
# ---------------------------------------------------------------------------

def _to_int(value: Any, default: int) -> int:
    """Convert a string/number/None to an int, falling back to `default`."""
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Returns a normalized dict.
    """
    action = payload.get("action", "run_command")
    sequential, nextPrompt = getSequential(payload)

    if action != "run_command":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    command = properties.get("command", "")
    cwd = properties.get("cwd", "")
    timeout = _to_int(properties.get("timeout"), 30)
    shell_str = properties.get("shell", "true")
    shelltype = properties.get("shelltype", "").strip()
    env_str = properties.get("env", "{}")
    description = properties.get("description", "")

    if not command:
        raise ValueError("Missing required property: 'command'")

    # Validate command safety
    dangerous = _is_dangerous(command)
    if dangerous:
        raise ValueError(f"Dangerous command pattern detected: {dangerous!r}")

    # Safety: clamp timeout
    if timeout < 1:
        timeout = 30
    if timeout > 120:
        timeout = 120

    # Parse shell flag
    shell = shell_str.lower() in ("true", "1", "yes")

    # Auto-detect shelltype if not specified
    if not shelltype:
        shelltype = _detect_shelltype()

    # Parse env (JSON object string -> dict)
    env = {}
    if env_str and env_str != "{}":
        try:
            env = json.loads(env_str)
            if not isinstance(env, dict):
                raise ValueError
        except (json.JSONDecodeError, ValueError):
            raise ValueError("Invalid 'env' – must be a JSON object")

    return {
        "action": action,
        "command": command,
        "cwd": cwd,
        "timeout": timeout,
        "shell": shell,
        "shelltype": shelltype,
        "env": env,
        "description": description,
        "sequential": sequential,
        "prompt": nextPrompt,
    }


# ---------------------------------------------------------------------------
# Core command execution operation
# ---------------------------------------------------------------------------

def execute_command_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    """
    Execute a shell command described by a execute_command JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative cwd paths are resolved
            against this directory. Defaults to current working dir.

    Returns:
        A string containing a JSON object with keys stdout, stderr, returncode.
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    # Resolve cwd
    # base_dir = base_dir or os.getcwd()
    # if data["cwd"]:
    #     if os.path.isabs(data["cwd"]):
    #         cwd = data["cwd"]
    #     else:
    #         cwd = os.path.abspath(os.path.join(base_dir, data["cwd"]))
    # else:
    cwd = base_dir

    # Ensure cwd exists
    if not os.path.isdir(cwd):
        return json.dumps({"error": f"cwd directory does not exist: {cwd}"})

    # Prepare subprocess arguments
    command = data["command"]
    shell = data["shell"]
    shelltype = data["shelltype"]
    timeout = data["timeout"]
    env = data.get("env") or None  # None means inherit from parent

    # Build the argument list based on shelltype and shell flag
    # If an explicit shelltype is available, use it with shell=False in subprocess.
    # Otherwise, fall back to the original behavior (shell=True/False with the
    # platform default shell).
    explicit_shell_args = _get_shell_command(shelltype, command)
    if explicit_shell_args is not None:
        # Use explicit shell executable (e.g., /bin/bash -c "command")
        args = explicit_shell_args
        use_shell = False
    elif not shell:
        # Original behavior: shell=False – split command string into args using shlex
        try:
            args = shlex.split(command)
        except ValueError as exc:
            return json.dumps({"error": f"Failed to parse command arguments: {exc}"})
        use_shell = False
    else:
        # Original behavior: shell=True – pass command as a string to the default shell
        args = command
        use_shell = True

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=False,  # We decode ourselves to handle encoding errors gracefully
            timeout=timeout,
            cwd=cwd,
            shell=use_shell,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        return json.dumps({
            "stdout": exc.stdout.decode(errors="replace") if exc.stdout else "",
            "stderr": exc.stderr.decode(errors="replace") if exc.stderr else "",
            "returncode": -1,
            "error": "Command timed out",
        })
    except OSError as exc:
        return json.dumps({"error": f"Failed to execute command: {exc}"})

    # Decode stdout/stderr with error handling
    stdout = result.stdout.decode(errors="replace") if result.stdout else ""
    stderr = result.stderr.decode(errors="replace") if result.stderr else ""
    content = ""
    if result.stdout:
        content += f"stdout:\n {stdout}\n"
    if result.stderr:
        content += f"stderr:\n {stderr}\n"
    if result.returncode:
        content += f"return code:\n {result.returncode}"

    seq = data["sequential"]
    return ExecutionResponse(
        content=content,
        prompt=data["prompt"],
        sequential=seq,
        print=True,
    )


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_cmd_runner_execute(json_payload: str, base_dir: str = "") -> str:
    """
    Execute a command-runner JSON payload and return the result.

    Args:
        json_payload: The JSON string (or fenced ```execute_command``` block).
        base_dir: Optional base directory for relative cwd paths.

    Returns:
        Human-readable status string containing JSON output, or an error
        message.
    """
    return execute_command_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "execute_command_from_payload",
    "skill_cmd_runner_execute",
]


@AxleExecutor(
    action="run_command",
    description="Execute a shell command using subprocess and return stdout/stderr/returncode.",
    version="1.1.0",
)
def execute_command(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_cmd_runner_execute(json_payload, base_dir)
