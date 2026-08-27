"""
Python Code Runner Skill - Core Implementation
============================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a fenced code block, or a Python dict, and execute the
specified Python script using the current Python interpreter.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential

# ---------------------------------------------------------------------------
# Danger detection
# ---------------------------------------------------------------------------

# Substrings that indicate sensitive script paths (case-insensitive).
_SENSITIVE_PATH_MARKERS = [
    "/etc/shadow",
    "/etc/",
    "/windows",
    "/.ssh/",
]


def _is_dangerous_path(path: str) -> Optional[str]:
    """Return the matched marker if the path is sensitive, else None."""
    normalized = path.replace("\\", "/")
    for marker in _SENSITIVE_PATH_MARKERS:
        if marker.lower() in normalized.lower():
            return marker
    return None


# ---------------------------------------------------------------------------
# Method support
# ---------------------------------------------------------------------------

_SUPPORTED_METHODS = {"script", "function"}


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
        return "bash"


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
    action = payload.get("action", "run_code_script")
    sequential, nextPrompt = getSequential(payload)

    if action != "run_code_script":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    path = properties.get("scriptPath", "")
    file = properties.get("fileName", "")
    if not path or not file:
        print("file path is invalid")
        raise ValueError("file path is invalid")
    script_path = os.path.join(path, file)
    method = properties.get("method", "script").strip().lower()
    timeout = _to_int(properties.get("timeout"), 30)
    shelltype = properties.get("shelltype", "").strip()
    env_str = properties.get("env", "{}")
    args_str = properties.get("args", "")
    description = properties.get("description", "")

    if not script_path:
        raise ValueError("Missing required property: 'scriptPath' or 'fileName'")

    if method not in _SUPPORTED_METHODS:
        raise ValueError(
            f"Unsupported method: {method!r}. "
            f"Supported methods: {', '.join(sorted(_SUPPORTED_METHODS))}"
        )

    if method == "function":
        function_name = properties.get("args", "")
        if not function_name:
            raise ValueError("Missing required property: 'args' when method is 'function'")

    # Safety: clamp timeout
    if timeout < 1:
        timeout = 30
    if timeout > 120:
        timeout = 120

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
        "scriptPath": script_path,
        "fileName": script_path,
        "method": method,
        "functionName": properties.get("args", ""),
        "timeout": timeout,
        "shelltype": shelltype,
        "env": env,
        "description": description,
        "sequential": sequential,
        "prompt": nextPrompt,
    }


# ---------------------------------------------------------------------------
# Core Python script execution operation
# ---------------------------------------------------------------------------

def execute_python_script_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    """
    Execute a Python script described by a run_code_script JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative script paths are resolved
            against this directory. Defaults to current working dir.

    Returns:
        A string containing a JSON object with keys stdout, stderr, returncode.
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    # Resolve script path
    script_path = data["scriptPath"]
    if not os.path.isabs(script_path) and base_dir:
        script_path = os.path.abspath(os.path.join(base_dir, script_path))
    elif not os.path.isabs(script_path):
        script_path = os.path.abspath(script_path)

    # Validate path safety
    dangerous = _is_dangerous_path(script_path)
    if dangerous:
        return json.dumps({"error": f"Dangerous script path pattern detected: {dangerous!r}"})

    if not os.path.isfile(script_path):
        return json.dumps({"error": f"Script file does not exist: {script_path}"})

    method = data["method"]
    # args = data["args"] or ""
    args = []
    env = data.get("env") or None

    # only support script for now
    if method == "script":
        # Default: run the whole script
        cmd = [sys.executable, script_path] + args
    else:
        return ExecutionResponse(content = "Invalid method type, only script is supported", 
                                prompt="Please regenerate the previous response.", sequential=True, print=True)
    # elif method == "function":
        # Run a specific function defined in the script
        # function_name = data["functionName"]
        # module_code = (
        #     "import runpy, sys; "
        #     "sys.argv = [sys.argv[0]] + " + json.dumps(args) + "; "
        #     "ns = runpy.run_path(sys.argv[0], run_name='__main__'); "
        #     "ns[" + json.dumps(function_name) + "]()"
        # )
        # cmd = [sys.executable, "-c", module_code, script_path]
    # elif method == "module":
    #     # Run as a module (e.g., python -m module.name)
    #     cmd = [sys.executable, "-m", script_path] + args
    # else:
    #     return json.dumps({"error": f"Unsupported method: {method!r}"})


    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=False,  # We decode ourselves to handle encoding errors gracefully
            timeout=data["timeout"],
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        return json.dumps({
            "stdout": exc.stdout.decode(errors="replace") if exc.stdout else "",
            "stderr": exc.stderr.decode(errors="replace") if exc.stderr else "",
            "returncode": -1,
            "error": "Script timed out",
        })
    except OSError as exc:
        return json.dumps({"error": f"Failed to execute script: {exc}"})

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

def skill_code_runner_execute(json_payload: str, base_dir: str = "") -> str:
    """
    Execute a code-runner JSON payload and return the result.

    Args:
        json_payload: The JSON string (or fenced block).
        base_dir: Optional base directory for relative script paths.

    Returns:
        Human-readable status string containing JSON output, or an error
        message.
    """
    return execute_python_script_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "execute_python_script_from_payload",
    "skill_code_runner_execute",
]


@AxleExecutor(
    action="run_code_script",
    description="Execute a Python script using subprocess and return stdout/stderr/returncode.",
    version="1.0.0",
)
def execute_code_script(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_code_runner_execute(json_payload, base_dir)
