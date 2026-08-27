"""
File Changer Skill - Core Implementation
========================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```file-changer ...``` fenced code block, or a Python
dict, and apply a change operation to an existing file on the filesystem.

Supported operations:
    - replace_all      : Replace the entire file content with `content`.
    - append           : Append `content` at the end of the file.
    - prepend          : Insert `content` at the beginning of the file.
    - replace_text     : Replace occurrences of `search` with `replacement`.
    - insert_at_line   : Insert `content` at 1-based `lineNumber`.
    - delete_lines     : Delete inclusive 1-based line range [startLine, endLine].
"""

from __future__ import annotations

import json
import os
import re
import shutil
from typing import Any, Dict, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------

# Paths that should never be modified (case-insensitive substring match).
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


_VALID_OPERATIONS = {
    "replace_all",
    "append",
    "prepend",
    "replace_text",
    "insert_at_line",
    "delete_lines",
}


# ---------------------------------------------------------------------------
# Payload validation & normalization
# ---------------------------------------------------------------------------

def _to_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() == "true"


def _to_int(v: Any, field: str) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Field {field!r} must be an integer, got {v!r}") from exc


def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Returns a normalized dict.
    """
    action = payload.get("action", "change_file")
    if action != "change_file":
        raise ValueError(f"Unsupported action: {action!r}")

    if "properties" not in payload or not isinstance(payload["properties"], list):
        raise ValueError("Missing 'properties' list in payload")

    properties = {p["name"]: p.get("value", "") for p in payload["properties"] if "name" in p}

    file_path = properties.get("filePath", "").strip()
    filename = properties.get("fileName", "").strip()
    operation = properties.get("operation", "").strip()
    encoding = properties.get("encoding", "").strip() or "utf-8"
    create_if_missing = _to_bool(properties.get("createIfMissing", "false"), False)
    backup = _to_bool(properties.get("backup", "false"), False)
    content = properties.get("content", "")
    search = properties.get("search", "")
    replacement = properties.get("replacement", "")
    line_number = properties.get("lineNumber", "")
    start_line = properties.get("startLine", "")
    end_line = properties.get("endLine", "")

    sequential, nextPrompt = getSequential(payload)

    if operation not in _VALID_OPERATIONS:
        raise ValueError(
            f"Invalid operation {operation!r}. Must be one of: {sorted(_VALID_OPERATIONS)}"
        )

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

    if any(ch in filename for ch in ("\n", "\r", "\0")):
        raise ValueError("Invalid characters in filename")

    # Operation-specific validation.
    if operation in {"replace_all", "append", "prepend"}:
        if content is None:
            raise ValueError(f"Operation {operation!r} requires 'content'")
    elif operation == "replace_text":
        if not search:
            raise ValueError("Operation 'replace_text' requires non-empty 'search'")
        # replacement may be empty string (deletion)
    elif operation == "insert_at_line":
        if content is None:
            raise ValueError("Operation 'insert_at_line' requires 'content'")
        line_number = _to_int(line_number, "lineNumber")
        if line_number < 1:
            raise ValueError("'lineNumber' must be >= 1")
    elif operation == "delete_lines":
        start_line = _to_int(start_line, "startLine")
        end_line = _to_int(end_line, "endLine")
        if start_line < 1 or end_line < 1:
            raise ValueError("'startLine' and 'endLine' must be >= 1")
        if end_line < start_line:
            raise ValueError("'endLine' must be >= 'startLine'")

    return {
        "action": action,
        "file_path": file_path,
        "filename": filename,
        "operation": operation,
        "encoding": encoding,
        "create_if_missing": create_if_missing,
        "backup": backup,
        "content": content,
        "search": search,
        "replacement": replacement,
        "line_number": line_number,
        "start_line": start_line,
        "end_line": end_line,
        "sequential": sequential,
        "prompt": nextPrompt
    }


# ---------------------------------------------------------------------------
# Change operations
# ---------------------------------------------------------------------------

def _apply_operation(original: str, data: Dict[str, Any]) -> str:
    """Return the new file content after applying the requested operation."""
    op = data["operation"]

    if op == "replace_all":
        return data["content"]

    if op == "append":
        # Ensure a newline separator if original doesn't end with one.
        if original and not original.endswith(("\n", "\r")):
            return original + "\n" + data["content"]
        return original + data["content"]

    if op == "prepend":
        return data["content"] + original

    if op == "replace_text":
        return original.replace(data["search"], data["replacement"])

    if op == "insert_at_line":
        lines = original.splitlines(keepends=True)
        idx = data["line_number"] - 1  # 1-based -> 0-based
        idx = max(0, min(idx, len(lines)))
        insertion = data["content"]
        # Guarantee inserted block ends with newline for cleanliness.
        if insertion and not insertion.endswith(("\n", "\r")):
            insertion += "\n"
        lines.insert(idx, insertion)
        return "".join(lines)

    if op == "delete_lines":
        lines = original.splitlines(keepends=True)
        start = data["start_line"] - 1  # inclusive
        end = data["end_line"]           # exclusive after -1+1
        start = max(0, start)
        end = min(len(lines), end)
        if start >= len(lines):
            return original  # nothing to delete
        del lines[start:end]
        return "".join(lines)

    raise ValueError(f"Unhandled operation: {op!r}")


# ---------------------------------------------------------------------------
# Core change-file operation
# ---------------------------------------------------------------------------

def change_file_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
):
    """
    Modify a file described by a file-changer JSON payload.

    Args:
        payload: Either the JSON string (optionally fenced) or a dict.
        base_dir: Optional base directory. Relative paths are resolved
            against this directory. Defaults to the current working dir.

    Returns:
        A human-readable status string.
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return _wrap_response(f"Invalid payload: {exc}", False, "")


    sequential = data["sequential"]
    prompt = data["prompt"]
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
        return _wrap_response(f"Blocked path (contains {blocked!r}); refusing to modify.", sequential, prompt)

    file_exists = os.path.isfile(full_path)

    if not file_exists:
        if not data["create_if_missing"]:
            return _wrap_response(f"File does not exist: {full_path}. Set 'createIfMissing': 'true' to create it.", sequential, prompt)
        # Create parent directories if needed.
        try:
            os.makedirs(full_dir, exist_ok=True)
        except OSError as exc:
            return _wrap_response(f"Failed to create directory {full_dir!r}: {exc}", sequential, prompt)
        original = ""
    else:
        # Read existing content.
        try:
            with open(full_path, "r", encoding=data["encoding"], newline="") as fh:
                original = fh.read()
        except OSError as exc:
            return _wrap_response(f"Failed to read file: {exc}", sequential, prompt)
        except LookupError as exc:
            return _wrap_response(f"Unknown encoding {data['encoding']!r}: {exc}", sequential, prompt)
        except UnicodeDecodeError as exc:
            return _wrap_response(f"Failed to decode file as {data['encoding']!r}: {exc}", sequential, prompt)

    # Optional backup.
    if data["backup"] and file_exists and not _is_in_git_repo(full_dir, full_path):
        backup_path = full_path + ".bak"
        try:
            shutil.copy2(full_path, backup_path)
            print(f"backup created at {backup_path}")
        except OSError as exc:
            return _wrap_response(f"Failed to create backup: {exc}", sequential, prompt)

    # Compute new content.
    try:
        new_content = _apply_operation(original, data)
    except ValueError as exc:
        return _wrap_response(f"Failed to apply operation: {exc}", sequential, prompt)

    # If nothing changed, short-circuit.
    if new_content == original and file_exists:
        return _wrap_response(f"No changes applied to {full_path} (content identical).", sequential, prompt)

    # Write the file.
    try:
        with open(full_path, "w", encoding=data["encoding"], newline="") as fh:
            print(f"file will be updated at {full_path} (operation={data['operation']})")
            fh.write(new_content if isinstance(new_content, str)
                     else json.dumps(new_content, indent=2, ensure_ascii=False))
    except OSError as exc:
        return _wrap_response(f"Failed to write file: {exc}", sequential, prompt)
    except LookupError as exc:
        return _wrap_response(f"Unknown encoding {data['encoding']!r}: {exc}", sequential, prompt)

    return _wrap_response(f"Successfully changed file: {full_path} (operation={data['operation']})", sequential, prompt)

def _is_in_git_repo(path: str, file_path: str):
    import subprocess
    is_in_git_repo = False
    git_installed = False
    try:
        subprocess.run(["git", "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        git_installed = True
    except FileNotFoundError:
        git_installed = False
    except OSError:
        git_installed = False

    if git_installed:
        try:
            result = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=path, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if result.returncode == 0:
                result = subprocess.run(["git", "ls-files", "--error-unmatch", file_path], cwd=path, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
                if result.returncode == 0:
                    is_in_git_repo = True

        except OSError:
            is_in_git_repo = False

    return is_in_git_repo


def _wrap_response(
    content_json: str,
    sequential: Any = None,
    next_prompt: Any = None,
) -> Dict[str, Any]:
    """Return the file-reader-style dict wrapping the grep result."""
    return ExecutionResponse(content = content_json, prompt = next_prompt, sequential = sequential, print = True)

# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_file_changer_execute(json_payload: str, base_dir: str = ""):
    """
    Execute a file-changer JSON payload and modify the file.

    Args:
        json_payload: The JSON string (or fenced ```file-changer``` block).
        base_dir: Optional base directory for relative paths.

    Returns:
        Human-readable status string.
    """
    return change_file_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "change_file_from_payload",
    "skill_file_changer_execute",
]


@AxleExecutor(
    action="change_file",
    description="Modify an existing file on disk from a file-changer JSON payload.",
    version="1.0.0",
)
def change_file(json_payload: str, base_dir: str = ""):
    print(f"file changer: changing file with payload...: {json_payload}")
    return skill_file_changer_execute(json_payload, base_dir)
