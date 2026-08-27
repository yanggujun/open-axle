"""
Curl Skill - Core Implementation
================================
The functions in this module accept either the raw JSON string, a JSON
string wrapped in a ```curl ...``` fenced code block, or a Python
dict, and execute an HTTP request via urllib.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.request
import urllib.error
import ssl
from typing import Any, Dict, Optional, Union
from urllib.parse import urlparse

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, getSequential, get_skill_config

# ---------------------------------------------------------------------------
# Safety - Blocked hosts
# ---------------------------------------------------------------------------

BLOCKED_HOSTS = [
    "0.0.0.0",
    "[::1]",
    "metadata.google.internal",
    "169.254.169.254",
]

ALLOWED_SCHEMES = ("http", "https")
DEFAULT_TIMEOUT = 30


def _is_blocked_host(url: str) -> Optional[str]:
    """Return the blocked hostname if present, else None."""
    parsed = urlparse(url)
    host = parsed.hostname
    if host is None:
        return None
    if host.lower() in BLOCKED_HOSTS:
        return host
    if host.startswith("10.") or host.startswith("172.16.") or host.startswith("192.168."):
        return host
    return None


# ---------------------------------------------------------------------------
# Payload validation & normalization
# ---------------------------------------------------------------------------

def _to_int(value: Any, default: int) -> int:
    """Convert a string/number/None to an int, falling back to default."""
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _resolve_auth_for_domain(hostname: Optional[str]) -> Optional[str]:
    if not hostname:
        return None

    try:
        curl_config = get_skill_config("curl", hostname)
    except Exception:
        # .axle file missing, malformed, or unreadable
        return None

    if not curl_config or not isinstance(curl_config, dict):
        return None

    # New format: config_items list with domain/auth_string per item
    auth_string = curl_config.get("auth_string")
    if auth_string:
        # Normalize "bearer" / "Bearer" prefix
        words = auth_string.split(None, 1)
        if words and words[0].lower() == "bearer":
            words[0] = "Bearer"
            auth_string = " ".join(words)
        if words and words[0].lower() == "basic":
            words[0] = "Basic"
            if words[1]:
                words[1] = base64.b64encode(words[1].encode("utf-8")).decode("ascii")
            auth_string = " ".join(words)
        return auth_string

    return None


def _normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Returns a normalized dict.
    """
    action = payload.get("action", "curl")
    sequential, next_prompt = getSequential(payload)

    if action != "curl":
        raise ValueError(f"Unsupported action: {action!r}")

    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    url = properties.get("url", "")
    method = properties.get("method", "GET").upper()
    headers_raw = properties.get("headers", "{}")
    data_raw = properties.get("data", "")
    timeout = _to_int(properties.get("timeout"), DEFAULT_TIMEOUT)
    encoding = properties.get("encoding", "utf-8") or "utf-8"

    if not url:
        raise ValueError("Missing required field: 'url'")

    # Validate URL scheme
    allowed_schemes = ("http", "https")
    parsed = urlparse(url)
    if parsed.scheme not in allowed_schemes:
        raise ValueError(f"URL scheme '{parsed.scheme}' not allowed. Only http/https are permitted.")

    # Blocked host check
    blocked = _is_blocked_host(url)
    if blocked:
        raise ValueError(f"Requests to '{blocked}' are blocked for security reasons.")

    # Method validation
    allowed_methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
    if method not in allowed_methods:
        raise ValueError(f"HTTP method '{method}' is not supported. Supported: {allowed_methods}")

    # Parse headers
    try:
        headers = json.loads(headers_raw) if isinstance(headers_raw, str) else headers_raw
    except json.JSONDecodeError:
        raise ValueError(f"Invalid headers JSON: {headers_raw}")
    if not isinstance(headers, dict):
        headers = {}

    # Resolve domain-based Authorization from .axle config.
    # This overrides any existing Authorization header if a match is found.
    print(f"host: {parsed.hostname}")
    auth_from_config = _resolve_auth_for_domain(parsed.hostname)
    if auth_from_config:
        headers["Authorization"] = auth_from_config

    # Data handling
    if method in ("POST", "PUT", "PATCH") and data_raw:
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/x-www-form-urlencoded"

    return {
        "action": action,
        "url": url,
        "method": method,
        "headers": headers,
        "data": data_raw,
        "timeout": timeout,
        "encoding": encoding,
        "sequential": sequential,
        "prompt": next_prompt,
    }


# ---------------------------------------------------------------------------
# Core curl execution
# ---------------------------------------------------------------------------

def execute_curl_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    try:
        raw = extract_json(payload)
        data = _normalize(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        return f"Invalid payload: {exc}"

    url = data["url"]
    method = data["method"]
    headers = data["headers"]
    data_raw = data["data"]
    timeout = data["timeout"]
    print(f"headers: {headers}")

    # Build request data bytes
    data_bytes = None
    if method in ("POST", "PUT", "PATCH") and data_raw:
        data_bytes = data_raw.encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

    try:
        context = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=context) as response:
            status_code = response.status
            response_headers = dict(response.headers.items())
            body = response.read().decode(data["encoding"], errors="replace")
            result = {
                "success": True,
                "status_code": status_code,
                "response_headers": response_headers,
                "body": body,
            }
    except urllib.error.HTTPError as e:
        result = {
            "success": False,
            "status_code": e.code,
            "response_headers": dict(e.headers.items()),
            "body": e.read().decode(data["encoding"], errors="replace"),
            "error": f"HTTP {e.code}: {e.reason}",
        }
    except urllib.error.URLError as e:
        result = {
            "success": False,
            "status_code": 0,
            "response_headers": {},
            "body": "",
            "error": f"URL error: {e.reason}",
        }
    except ssl.SSLError as e:
        result = {
            "success": False,
            "status_code": 0,
            "response_headers": {},
            "body": "",
            "error": f"SSL error: {e}",
        }
    except Exception as e:
        result = {
            "success": False,
            "status_code": 0,
            "response_headers": {},
            "body": "",
            "error": f"Unexpected error: {e}",
        }

    seq = data["sequential"]
    content = f"status code:\n{result['status_code']}\n"
    content += f"header:\n{result['response_headers']}\n"
    if result["success"]:
        content += f"body:\n{body}"
    if not result["success"]:
        content += f"error:\n{result['error']}"
    return ExecutionResponse(
        content=content,
        prompt=data["prompt"],
        sequential=seq,
        print=not seq,
    )


# ---------------------------------------------------------------------------
# Skill wrapper function (called by the SkillManager)
# ---------------------------------------------------------------------------

def skill_curl_execute(json_payload: str, base_dir: str = "") -> str:
    """
    Execute a curl JSON payload and return the HTTP response.

    Args:
        json_payload: The JSON string (or fenced ```curl``` block).
        base_dir: Optional base directory (unused but kept for compatibility).

    Returns:
        Human-readable status string containing the HTTP response, or an
        error message.
    """
    return execute_curl_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "execute_curl_from_payload",
    "skill_curl_execute",
]


@AxleExecutor(
    action="curl",
    description="Execute an HTTP request using a curl JSON payload.",
    version="1.1.0",
)
def execute_curl(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_curl_execute(json_payload, base_dir)
