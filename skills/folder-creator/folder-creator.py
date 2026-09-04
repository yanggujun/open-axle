"""
Folder Creator Skill - Core Implementation
===========================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```folder-creator ...``` fenced code block, or a Python
dict, and turn that into a real folder on the filesystem.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Union

from executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

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
    Returns a normalized dict for folder creation.
    """
    action = payload.get("action", "create_folder")
    if action != "create_folder":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload["properties"]}

    # Extract and validate fields
    folder_path = properties.get("folderPath", "")
    folder_name = properties.get("folderName", "")

    # Allow folder_path to be a full path (containing the folder name).
    if not folder_path and not folder_name:
        raise ValueError("Must provide 'folderPath' and/or 'folderName'")

    if not folder_path:
        folder_path = "./"

    # If folder_path already looks like it includes a folder name, split it.
    base = os.path.basename(folder_path)
    if base and not folder_name:
        folder_name = base
        folder_path = os.path.dirname(folder_path) or "./"

    if not folder_name:
        raise ValueError("Missing required field: 'folderName'")

    # Basic sanity checks on folder name.
    if any(ch in folder_name for ch in ("\n", "\r", "\0")):
        raise ValueError("Invalid characters in folderName")

    # Optional fields with defaults
    recursive_string = properties.get("recursive", "true")
    recursive = recursive_string.lower() == "true"


    encoding = properties.get("encoding", "utf-8")

    description = properties.get("description", "")

    sequential, next_prompt = getSequential(payload)

    return {
        "action": action,
        "folder_path": folder_path,
        "folder_name": folder_name,
        "recursive": recursive,
        "encoding": encoding,
        "description": description,
        "sequential": sequential,
        "prompt": next_prompt,
    }


# ---------------------------------------------------------------------------
# Core create-folder operation
# ---------------------------------------------------------------------------


def create_folder_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
):
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return f"Invalid payload: {exc}"

    base_dir = base_dir or os.getcwd()
    target_dir = data["folder_path"]

    # Resolve target path.
    if os.path.isabs(target_dir):
        full_dir = target_dir
    else:
        full_dir = os.path.abspath(os.path.join(base_dir, target_dir))

    full_path = os.path.abspath(os.path.join(full_dir, data["folder_name"]))

    # Safety check.
    blocked = _is_blocked_path(full_path)
    if blocked:
        return f"Blocked path (contains {blocked!r}); refusing to create folder."

    # Overwrite guard: if folder exists and overwrite is false, skip (or error).
    if os.path.exists(full_path):
        return ExecutionResponse(
            content=f"Folder already exists at {full_path}",
            prompt=data["prompt"],
            sequential=data["sequential"],
            print=True,
        )

    # Create the folder.
    try:
        if data["recursive"]:
            os.makedirs(full_path, exist_ok=True)
        else:
            # Only the last component should be created; parent must exist
            parent = os.path.dirname(full_path)
            if not os.path.isdir(parent):
                return (
                    f"Parent directory {parent!r} does not exist. "
                    "Set recursive=true to create intermediate directories."
                )
            os.mkdir(full_path)

        return ExecutionResponse(
            content=f"Folder created at {full_path}",
            prompt=data["prompt"],
            sequential=data["sequential"],
            print=True,
        )
    except OSError as exc:
        return f"Failed to create folder: {exc}"


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------


def skill_folder_creator_execute(json_payload: str, base_dir: str = ""):
    return create_folder_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )

__all__ = [
    "create_folder_from_payload",
    "skill_folder_creator_execute"
]


# ---------------------------------------------------------------------------
# Decorator-based skill registration
# ---------------------------------------------------------------------------


@AxleExecutor(
    action="create_folder",
    description="Create a folder on disk from a folder-creator JSON payload.",
    version="1.0.0",
)
def create_folder(json_payload: str, base_dir: str = ""):
    print(f"folder creator: creating folder...")
    return skill_folder_creator_execute(json_payload, base_dir)
