"""
File Finder Skill - Core Implementation
========================================
Find files by name pattern (glob or regex) in a directory tree.
Accepts a file-finder JSON payload and returns a dict with matched file paths.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential

# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------

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
    low = path.replace("\\", "\\").lower()
    for frag in _BLOCKED_PATH_FRAGMENTS:
        if frag.lower() in low:
            return frag
    return None


# ---------------------------------------------------------------------------
# Payload normalization
# ---------------------------------------------------------------------------


def _to_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = str(v).strip().lower()
    if s == "":
        return default
    return s == "true"


def _to_int(v: Any, default: int) -> int:
    try:
        s = str(v).strip()
        if not s:
            return default
        return int(s)
    except (TypeError, ValueError):
        return default


_DEFAULT_EXCLUDES = ".git,node_modules,__pycache__,.venv,dist,build"


def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    action = payload.get("action", "find_file")
    if action != "find_file":
        raise ValueError(f"Unsupported action: {action!r}")

    if "properties" not in payload or not isinstance(payload["properties"], list):
        raise ValueError("Missing 'properties' list in payload")

    props = {p["name"]: p.get("value", "") for p in payload["properties"] if "name" in p}

    pattern = props.get("pattern", "")
    if not isinstance(pattern, str) or pattern == "":
        raise ValueError("Missing required field: 'pattern'")

    path = (props.get("path") or "").strip() or "./"
    recursive = _to_bool(props.get("recursive", "true"), True)
    is_regex = _to_bool(props.get("isRegex", "false"), False)
    case_sensitive = _to_bool(props.get("caseSensitive", "false"), False)
    include_glob = (props.get("includeGlob") or "").strip() or "*"
    exclude_glob = (props.get("excludeGlob") or "").strip() or _DEFAULT_EXCLUDES
    max_results = _to_int(props.get("maxResults", "100"), 100)
    if max_results <= 0:
        max_results = 100
    show_paths = _to_bool(props.get("showPaths", "true"), True)

    sequential, next_prompt = getSequential(payload)

    excludes: List[str] = [g.strip() for g in exclude_glob.split(",") if g.strip()]

    return {
        "action": action,
        "pattern": pattern,
        "path": path,
        "recursive": recursive,
        "is_regex": is_regex,
        "case_sensitive": case_sensitive,
        "include_glob": include_glob,
        "excludes": excludes,
        "max_results": max_results,
        "show_paths": show_paths,
        "sequential": sequential,
        "prompt": next_prompt,
    }


# ---------------------------------------------------------------------------
# File walking / filtering
# ---------------------------------------------------------------------------


def _matches_any_glob(name: str, patterns: List[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def _iter_files(root: str, recursive: bool, include_glob: str,
                excludes: List[str]):
    """Yield candidate file paths under root."""
    if os.path.isfile(root):
        yield root
        return

    if recursive:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if not _matches_any_glob(d, excludes)
            ]
            for fname in filenames:
                if _matches_any_glob(fname, excludes):
                    continue
                if not fnmatch.fnmatch(fname, include_glob):
                    continue
                yield os.path.join(dirpath, fname)
    else:
        try:
            entries = os.listdir(root)
        except OSError:
            return
        for name in entries:
            full = os.path.join(root, name)
            if not os.path.isfile(full):
                continue
            if _matches_any_glob(name, excludes):
                continue
            if not fnmatch.fnmatch(name, include_glob):
                continue
            yield full


# ---------------------------------------------------------------------------
# Core find
# ---------------------------------------------------------------------------


def _filename_matches(basename: str, pattern: str, is_regex: bool, case_sensitive: bool) -> bool:
    if is_regex:
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            return re.search(pattern, basename, flags) is not None
        except re.error:
            return False
    else:
        if case_sensitive:
            return fnmatch.fnmatch(basename, pattern)
        else:
            return fnmatch.fnmatch(basename.lower(), pattern.lower())


def find_files_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> ExecutionResponse:
    """
    Execute the file-find described by a file-finder payload.

    Returns:
        A dict shaped like the file-reader response:
            {
                "sequential": <bool or None>,
                "content": "<JSON string of the find result>",
                "prompt": "<optional follow-up prompt>",
                "print": True
            }
    """
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except ValueError as exc:
        return _wrap_response(_error_content_json(f"Invalid payload: {exc}"))

    base_dir = base_dir or os.getcwd()
    target = data["path"]
    if os.path.isabs(target):
        root = target
    else:
        root = os.path.abspath(os.path.join(base_dir, target))

    blocked = _is_blocked_path(root)
    if blocked:
        return _wrap_response(
            _error_content_json(
                f"Blocked path (contains {blocked!r}); refusing to search."
            ),
            sequential=data["sequential"],
            next_prompt=data["prompt"],
        )

    if not os.path.exists(root):
        return _wrap_response(
            _error_content_json(f"Search path does not exist: {root}"),
            sequential=data["sequential"],
            next_prompt=data["prompt"],
        )

    print(
        f"file finder: searching {root!r} for pattern={data['pattern']!r} "
        f"(regex={data['is_regex']}, case_sensitive={data['case_sensitive']})"
    )

    matched_files: List[str] = []
    scanned = 0

    for fpath in _iter_files(
        root, data["recursive"], data["include_glob"], data["excludes"]
    ):
        scanned += 1
        basename = os.path.basename(fpath)
        if _filename_matches(basename, data["pattern"], data["is_regex"], data["case_sensitive"]):
            if data["show_paths"]:
                matched_files.append(os.path.abspath(fpath))
            else:
                matched_files.append(os.path.relpath(fpath, root))
            if len(matched_files) >= data["max_results"]:
                break

    if not matched_files:
        return _wrap_response("No file is found", sequential=False)

    files = ""
    for fp in matched_files:
        files += fp + "\n"
    
    return _wrap_response(files,
        sequential=data["sequential"],
        next_prompt=data["prompt"],
    )


def _error_content_json(msg: str) -> str:
    return json.dumps(
        {
            "action": "find_file",
            "status": "error",
            "message": msg,
            "matches": [],
            "totalMatchingFiles": 0,
            "filesScanned": 0,
        },
        ensure_ascii=False,
        indent=2,
    )


def _wrap_response(
    content_json: str,
    sequential: Any = None,
    next_prompt: Any = None,
) -> Dict[str, Any]:
    return ExecutionResponse(content=content_json, prompt=next_prompt, sequential=sequential, print=True)


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------


def skill_file_finder_execute(json_payload: str, base_dir: str = "") -> Dict[str, Any]:
    """
    Execute a file-finder JSON payload and return the find report.

    Args:
        json_payload: The JSON string (or fenced ```file-finder``` block).
        base_dir: Optional base directory for relative paths.

    Returns:
        A dict with keys: sequential, content (JSON string of the find result),
        prompt, print.
    """
    return find_files_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "find_files_from_payload",
    "skill_file_finder_execute",
]


@AxleExecutor(
    action="find_file",
    description="Find files by name pattern (glob or regex) and return matching file paths.",
    version="1.0.0",
)
def find_file(json_payload: str, base_dir: str = "") -> Dict[str, Any]:
    print(f"file finder: running find with payload...")
    return skill_file_finder_execute(json_payload, base_dir)
