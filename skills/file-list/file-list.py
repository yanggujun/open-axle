"""
File List Skill - Core Implementation
======================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```file-list ...``` fenced code block, or a Python
dict, and list the files in the specified directory.
"""

from __future__ import annotations

import json
import os
import re
import fnmatch
from typing import Any, Dict, List, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------

# Paths that should never be listed (case-insensitive substring match).
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
# Helper functions
# ---------------------------------------------------------------------------

def _to_bool(value: Any, default: bool) -> bool:
    """Convert a string/number/None to a bool, falling back to `default`."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _to_int(value: Any, default: int) -> int:
    """Convert a string/number/None to an int, falling back to `default`."""
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Payload validation & normalization
# ---------------------------------------------------------------------------

def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Returns a normalized dict.
    """
    action = payload.get("action", "list_files")
    sequential, nextPrompt = getSequential(payload)

    if action != "list_files":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    directory_path = properties.get("directoryPath", "./")
    recursive = _to_bool(properties.get("recursive"), False)
    include_hidden = _to_bool(properties.get("includeHidden"), False)
    include_glob = properties.get("includeGlob", "*") or "*"
    exclude_glob = properties.get("excludeGlob", "") or ""
    show_details = _to_bool(properties.get("showDetails"), False)
    max_results = _to_int(properties.get("maxResults"), 500)
    if max_results < 1:
        max_results = 500

    # Basic sanity checks
    if any(ch in directory_path for ch in ("\n", "\r", "\0")):
        raise ValueError("Invalid characters in directoryPath")

    return {
        "action": action,
        "directory_path": directory_path,
        "recursive": recursive,
        "include_hidden": include_hidden,
        "include_glob": include_glob,
        "exclude_glob": exclude_glob,
        "show_details": show_details,
        "max_results": max_results,
        "sequential": sequential,
        "prompt": nextPrompt,
    }


# ---------------------------------------------------------------------------
# Core list-file operation
# ---------------------------------------------------------------------------

def list_files_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    """
    List files in a directory described by a file-list JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative paths are resolved
            against this directory. Defaults to the current working dir.

    Returns:
        An ExecutionResponse object containing a formatted listing string.
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return f"Invalid payload: {exc}"

    base_dir = base_dir or os.getcwd()
    target_dir = data["directory_path"]

    # Resolve target path.
    if os.path.isabs(target_dir):
        full_dir = target_dir
    else:
        full_dir = os.path.abspath(os.path.join(base_dir, target_dir))

    # Safety check.
    blocked = _is_blocked_path(full_dir)
    if blocked:
        return f"Blocked path (contains {blocked!r}); refusing to list."

    # Existence & type checks.
    if not os.path.exists(full_dir):
        return f"Directory not found: {full_dir}"
    if not os.path.isdir(full_dir):
        return f"Path is not a directory: {full_dir}"

    include_glob = data["include_glob"]
    exclude_glob = data["exclude_glob"]
    exclude_patterns = [g.strip() for g in exclude_glob.split(",") if g.strip()] if exclude_glob else []
    max_results = data["max_results"]
    show_details = data["show_details"]

    entries: List[Any] = []

    if data["recursive"]:
        # Walk the directory tree recursively.
        for root, dirs, files in os.walk(full_dir):
            # Filter hidden directories immediately to avoid traversing them.
            if not data["include_hidden"]:
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                files = [f for f in files if not f.startswith(".")]

            for fname in files:
                # Apply glob filters to the base filename.
                if include_glob != "*":
                    if not fnmatch.fnmatch(fname, include_glob):
                        continue
                if exclude_patterns:
                    if any(fnmatch.fnmatch(fname, pat) for pat in exclude_patterns):
                        continue

                rel_path = os.path.relpath(os.path.join(root, fname), full_dir)
                full_path = os.path.join(root, fname)
                if show_details:
                    try:
                        stat = os.stat(full_path)
                        size = stat.st_size
                        mtime = stat.st_mtime
                    except OSError:
                        size = 0
                        mtime = 0
                    entries.append((full_path, size, mtime))
                else:
                    entries.append(full_path)

                if len(entries) >= max_results:
                    break
            if len(entries) >= max_results:
                break
    else:
        # Flat listing using scandir for better performance.
        try:
            with os.scandir(full_dir) as it:
                for entry in it:
                    if not entry.is_file():
                        continue
                    fname = entry.name

                    # Hidden file filter.
                    if not data["include_hidden"] and fname.startswith("."):
                        continue

                    # Glob filters.
                    if include_glob != "*":
                        if not fnmatch.fnmatch(fname, include_glob):
                            continue
                    if exclude_patterns:
                        if any(fnmatch.fnmatch(fname, pat) for pat in exclude_patterns):
                            continue

                    if show_details:
                        try:
                            stat = entry.stat()
                            size = stat.st_size
                            mtime = stat.st_mtime
                        except OSError:
                            size = 0
                            mtime = 0
                        entries.append((os.path.join(full_dir, fname), size, mtime))
                    else:
                        entries.append(os.path.join(full_dir, fname))

                    if len(entries) >= max_results:
                        break
        except PermissionError:
            return f"Permission denied to read directory: {full_dir}"

    # Format the output.
    lines = []
    if not entries:
        lines.append("(empty directory)")
    else:
        if show_details:
            # Column headers (optional, but helpful).
            lines.append(f"{'Name':40s} {'Size':>10s} {'Modified':>12s}")
            lines.append("-" * 65)
            for name, size, mtime in entries:
                lines.append(f"{name:40s} {size:>10d} {int(mtime)}")
        else:
            lines.extend(entries)

    content = "\n".join(lines)
    return ExecutionResponse(content=content, prompt=data["prompt"], sequential=data["sequential"], print=True)


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_file_list_execute(json_payload: str, base_dir: str = "") -> str:
    """
    Execute a file-list JSON payload and list files.

    Args:
        json_payload: The JSON string (or fenced ```file-list``` block).
        base_dir: Optional base directory for relative paths.

    Returns:
        Human-readable status string containing the file listing, or an
        error message.
    """
    return list_files_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "list_files_from_payload",
    "skill_file_list_execute",
]


@AxleExecutor(
    action="list_files",
    description="List files in a directory using a file-list JSON payload.",
    version="1.0.0",
)
def list_files(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_file_list_execute(json_payload, base_dir)
