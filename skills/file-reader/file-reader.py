"""
File Reader Skill - Core Implementation
=======================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```file-reader ...``` fenced code block, or a Python
dict, and read the corresponding file from the filesystem.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Optional, Union

from executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------

# Paths that should never be read from (case-insensitive substring match).
_BLOCKED_PATH_FRAGMENTS = [
    r"c:\windows",
    r"c:\program files",
    r"c:\program files (x86)",
    "/etc/shadow",
    "/etc/passwd",
    "/boot/",
    "/system32",
    "~/.ssh",
    ".ssh/id_rsa",
]


def _is_blocked_path(path: str) -> Optional[str]:
    """Return the offending fragment if the path is blocked, else None."""
    low = path.replace("\\", "\\").lower()
    for frag in _BLOCKED_PATH_FRAGMENTS:
        if frag.lower() in low:
            return frag
    return None


# ---------------------------------------------------------------------------
# Payload validation & normalization
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
    action = payload.get("action", "read_file")
    sequential, nextPrompt = getSequential(payload)
        
    if action != "read_file":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    file_path = properties.get("filePath", "")
    filename = properties.get("fileName", "")
    encoding = properties.get("encoding", "utf-8") or "utf-8"
    max_bytes = _to_int(properties.get("maxBytes"), 0)
    start_line = _to_int(properties.get("startLine"), 1)
    end_line = _to_int(properties.get("endLine"), 0)

    # Allow file_path to be a full path (containing the filename).
    if not file_path and not filename:
        raise ValueError("Must provide 'filePath' and/or 'fileName'")

    if not file_path:
        file_path = "./"

    # If file_path already looks like it includes a filename, split it.
    base = os.path.basename(file_path)
    if base and "." in base and not filename:
        filename = base
        file_path = os.path.dirname(file_path) or "./"

    if not filename:
        raise ValueError("Missing required field: 'fileName'")

    # Basic sanity checks on filename.
    if any(ch in filename for ch in ("\n", "\r", "\0")):
        raise ValueError("Invalid characters in filename")

    if start_line < 1:
        start_line = 1
    if end_line < 0:
        end_line = 0

    if sequential and nextPrompt:
        nextPrompt = nextPrompt + "\n" + "Following is the file content: \n"
    return {
        "action": action,
        "file_path": file_path,
        "filename": filename,
        "encoding": encoding,
        "max_bytes": max_bytes,
        "start_line": start_line,
        "end_line": end_line,
        "sequential": sequential,
        "prompt": nextPrompt
    }


# ---------------------------------------------------------------------------
# Core read-file operation
# ---------------------------------------------------------------------------

def read_file_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    """
    Read a file described by a file-reader JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative paths are resolved
            against this directory. Defaults to the current working dir.

    Returns:
        A string containing a short status header followed by the file's
        content, or an error message if the read failed.
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return f"Invalid payload: {exc}"

    base_dir = base_dir or os.getcwd()
    target_dir = data["file_path"]

    # Resolve target path.
    if os.path.isabs(target_dir):
        full_dir = target_dir
    else:
        full_dir = os.path.abspath(os.path.join(base_dir, target_dir))

    full_path = os.path.abspath(os.path.join(full_dir, data["filename"]))

    # Safety check.
    blocked = _is_blocked_path(full_path)
    if blocked:
        return f"Blocked path (contains {blocked!r}); refusing to read."

    # Existence & type checks.
    if not os.path.exists(full_path):
        return f"File not found: {full_path}"
    if not os.path.isfile(full_path):
        return f"Path is not a regular file: {full_path}"

    # Read the file.
    try:
        print(f"file will be read from {full_path}")
        with open(full_path, "r", encoding=data["encoding"], newline="") as fh:
            if data["end_line"] > 0 or data["start_line"] > 1:
                # Line-range read.
                lines = fh.readlines()
                start = max(1, data["start_line"])
                end = data["end_line"] if data["end_line"] > 0 else len(lines)
                end = min(end, len(lines))
                content = "".join(lines[start - 1 : end])
            elif data["max_bytes"] > 0:
                content = fh.read(data["max_bytes"])
            else:
                content = fh.read()
    except OSError as exc:
        return f"Failed to read file: {exc}"
    except LookupError as exc:
        return f"Unknown encoding {data['encoding']!r}: {exc}"
    except UnicodeDecodeError as exc:
        return f"Failed to decode file with encoding {data['encoding']!r}: {exc}"

    seq = data["sequential"]
    return ExecutionResponse(content = content, prompt = data["prompt"], sequential = seq, print = not seq)


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_file_reader_execute(json_payload: str, base_dir: str = "") -> str:
    """
    Execute a file-reader JSON payload and read the file.

    Args:
        json_payload: The JSON string (or fenced ```file-reader``` block).
        base_dir: Optional base directory for relative paths.

    Returns:
        Human-readable status string containing the file content, or an
        error message.
    """
    return read_file_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "read_file_from_payload",
    "skill_file_reader_execute",
]


@AxleExecutor(
    action="read_file",
    description="Read a file from disk using a file-reader JSON payload.",
    version="1.0.0",
)
def read_file(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_file_reader_execute(json_payload, base_dir)