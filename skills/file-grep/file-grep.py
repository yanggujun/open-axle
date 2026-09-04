
from __future__ import annotations

import fnmatch
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from executor import AxleExecutor, ExecutionResponse, extract_json, getSequential  # noqa: E402

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
    action = payload.get("action", "grep_file")
    if action != "grep_file":
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
    show_lines = _to_bool(props.get("showLines", "true"), True)

    # file-reader-style optional fields for chaining follow-up prompts.
    sequential, nextPrompt = getSequential(payload)

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
        "show_lines": show_lines,
        "sequential": sequential,
        "prompt": nextPrompt
    }


# ---------------------------------------------------------------------------
# File walking / filtering
# ---------------------------------------------------------------------------

_BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib", ".class", ".jar",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
    ".pyc", ".pyo",
}


def _is_probably_binary(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext in _BINARY_EXT:
        return True
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(2048)
        if b"\x00" in chunk:
            return True
    except OSError:
        return True
    return False


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
# Core grep
# ---------------------------------------------------------------------------

def _search_file(path: str, matcher, show_lines: bool) -> List[Tuple[int, str]]:
    """Return list of (line_number, line_text) matches for a file."""
    results: List[Tuple[int, str]] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, start=1):
                if matcher(line):
                    if show_lines:
                        results.append((lineno, line.rstrip("\n")))
                    else:
                        results.append((lineno, ""))
                        break
    except OSError:
        return []
    return results


def _error_content_json(msg: str) -> str:
    return json.dumps(
        {
            "action": "grep_file",
            "status": "error",
            "message": msg,
            "matches": [],
            "totalMatchingFiles": 0,
            "totalLineMatches": 0,
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
    """Return the file-reader-style dict wrapping the grep result."""
    return ExecutionResponse(content = content_json, prompt = next_prompt, sequential = sequential, print = True)


def grep_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> ExecutionResponse:
    """
    Execute the grep described by a file-grep payload.

    Returns:
        A dict shaped like the file-reader response:
            {
                "sequential": <bool or None>,
                "content": "<JSON string of the grep result>",
                "prompt": "<optional follow-up prompt>",
                "print": True
            }
        On error the parsed `content` JSON has status="error" and a
        `message` field describing the failure.
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

    # Build matcher.
    if data["is_regex"]:
        try:
            flags = 0 if data["case_sensitive"] else re.IGNORECASE
            regex = re.compile(data["pattern"], flags)
        except re.error as exc:
            return _wrap_response(
                _error_content_json(f"Invalid regex pattern: {exc}"),
                sequential=data["sequential"],
                next_prompt=data["prompt"],
            )
        matcher = lambda line: regex.search(line) is not None  # noqa: E731
    else:
        needle = data["pattern"] if data["case_sensitive"] else data["pattern"].lower()
        if data["case_sensitive"]:
            matcher = lambda line: needle in line  # noqa: E731
        else:
            matcher = lambda line: needle in line.lower()  # noqa: E731

    print(
        f"file grep: searching {root!r} for pattern={data['pattern']!r} "
        f"(regex={data['is_regex']}, case_sensitive={data['case_sensitive']})"
    )

    matched_files: List[Tuple[str, List[Tuple[int, str]]]] = []
    total_line_matches = 0
    scanned = 0

    for fpath in _iter_files(
        root, data["recursive"], data["include_glob"], data["excludes"]
    ):
        scanned += 1
        if _is_probably_binary(fpath):
            continue
        hits = _search_file(fpath, matcher, data["show_lines"])
        if hits:
            matched_files.append((fpath, hits))
            total_line_matches += len(hits) if data["show_lines"] else 1
            if len(matched_files) >= data["max_results"]:
                break

    # Build the JSON result payload.
    matches_json: List[Dict[str, Any]] = []
    files = ""
    for fpath, hits in matched_files:
        files += fpath + "\n"
        entry: Dict[str, Any] = {"filePath": fpath}
        if data["show_lines"]:
            entry["lines"] = [
                {
                    "lineNumber": lineno,
                    "text": (text if len(text) <= 400 else text[:400] + "..."),
                }
                for lineno, text in hits
            ]
        matches_json.append(entry)

    return _wrap_response(
        files,
        sequential=data["sequential"],
        next_prompt=data["prompt"],
    )


# ---------------------------------------------------------------------------
# Skill wrapper functions (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_file_grep_execute(json_payload: str, base_dir: str = "") -> Dict[str, Any]:
    """
    Execute a file-grep JSON payload and return the search report.

    Args:
        json_payload: The JSON string (or fenced ```file-grep``` block).
        base_dir: Optional base directory for relative paths. Defaults
            to the current working directory.

    Returns:
        A dict with keys: sequential, content (JSON string of the grep
        result), prompt, print. Mirrors the file-reader response shape.
    """
    return grep_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "grep_from_payload",
    "skill_file_grep_execute",
]


@AxleExecutor(
    action="grep_file",
    description="Search files for a text/regex pattern and return matching file locations.",
    version="1.0.0",
)
def grep_file(json_payload: str, base_dir: str = "") -> Dict[str, Any]:
    print(f"file grep: running grep with payload...")
    return skill_file_grep_execute(json_payload, base_dir)
