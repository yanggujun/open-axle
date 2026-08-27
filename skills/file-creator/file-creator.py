"""
File Creator Skill - Core Implementation
========================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```file-creator ...``` fenced code block, or a Python
dict, and turn that into a real file on the filesystem.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Dict, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------

# Paths that should never be written to (case-insensitive substring match).
_BLOCKED_PATH_FRAGMENTS = [
    r"c:\windows",
    r"c:\program files",
    r"c:\program files (x86)",
    "/etc/",
    "/bin/",
    "/sbin/",
    "/usr/bin/",
    "/usr/sbin/",
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

def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Returns a normalized dict.
    """
    action = payload.get("action", "create_file")
    if action != "create_file":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload["properties"]}
    file_path = properties["filePath"]
    filename = properties["fileName"]
    content = properties["content"]
    encoding = properties["encoding"]
    overwrite = properties["overwrite"].lower() == "true"
    sequential, nextPrompt = getSequential(payload)


    # Allow file_path to be a full path (containing the filename).
    if not file_path and not filename:
        raise ValueError("Must provide 'file_path' and/or 'filename'")

    if not file_path:
        file_path = "./"

    # If file_path already looks like it includes a filename, split it.
    base = os.path.basename(file_path)
    if base and "." in base and not filename:
        filename = base
        file_path = os.path.dirname(file_path) or "./"

    if not filename:
        raise ValueError("Missing required field: 'filename'")

    # Basic sanity checks on filename.
    if any(ch in filename for ch in ("\n", "\r", "\0")):
        raise ValueError("Invalid characters in filename")

    return {
        "action": action,
        "file_path": file_path,
        "filename": filename,
        "encoding": encoding,
        "overwrite": overwrite,
        "content": content,
        "sequential": sequential,
        "prompt": nextPrompt
    }


# ---------------------------------------------------------------------------
# Core create-file operation
# ---------------------------------------------------------------------------

def create_file_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None
):
    """
    Create a file described by a file-creator JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative paths are resolved
            against this directory. Defaults to the current working dir.

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
        return f"Blocked path (contains {blocked!r}); refusing to write."

    # Overwrite guard.
    if os.path.exists(full_path) and not data["overwrite"]:
        return "File already exists and overwrite=false. Set 'overwrite': true to replace it."

    # Create parent directories.
    try:
        os.makedirs(full_dir, exist_ok=True)
    except OSError as exc:
        return f"Failed to create directory {full_dir!r}: {exc}"

    # Write the file.
    try:
        content = data["content"]
        # Content should be a str; if we somehow got a dict/list, JSON-encode.
        if not isinstance(content, str):
            content = json.dumps(content, indent=2, ensure_ascii=False)

        with open(full_path, "w", encoding=data["encoding"], newline="") as fh:
            print(f"file will be written to {full_path}")
            fh.write(content)
            return ExecutionResponse(content = "file is created.", prompt = data["prompt"], sequential=data["sequential"], print = True)
    except OSError as exc:
        return f"Failed to write file: {exc}"
    except LookupError as exc:
        return f"Unknown encoding {data['encoding']!r}: {exc}"

# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_file_creator_execute(json_payload: str, base_dir: str = ""):
    """
    Execute a file-creator JSON payload and create the file.

    Args:
        json_payload: The JSON string (or fenced ```file-creator``` block).
        base_dir: Optional base directory for relative paths.

    Returns:
        Human-readable status string.
    """
    return create_file_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "create_file_from_payload",
    "skill_file_creator_execute"
]


@AxleExecutor(
    action="create_file",
    description="Create a file on disk from a file-creator JSON payload.",
    version="1.0.0",
)
def create_file(json_payload: str, base_dir: str = ""):
    print(f"file creator: creating file...: ")
    return skill_file_creator_execute(json_payload, base_dir)