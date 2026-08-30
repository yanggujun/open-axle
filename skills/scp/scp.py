from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, get_skill_config, getSequential


DEFAULT_TIMEOUT = 30
DEFAULT_MAX_OUTPUT = 1048576


def _to_int(value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def _is_sensitive_path(path: str) -> Optional[str]:
    if not path or not path.strip():
        return None
    normalized = os.path.normpath(path.strip())
    normalized_lower = normalized.lower()
    sensitive_patterns = [
        "/etc/shadow", "/etc/passwd", "/root/", "~/.ssh/",
        "%systemroot%", "c:\\windows", "/etc/ssh/",
    ]
    for pattern in sensitive_patterns:
        if pattern.lower() in normalized_lower:
            return f"sensitive path: {pattern}"
    return None


def _normalize(payload: Dict[str, Any], base_dir: Optional[str] = None) -> Dict[str, Any]:
    action = payload.get("action", "scp")
    sequential, next_prompt = getSequential(payload)
    if action != "scp":
        raise ValueError(f"Unsupported action: {action!r}")
    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    operation = properties.get("operation", "").strip().lower()
    if operation not in ("upload", "download"):
        raise ValueError(f"Invalid operation: {operation}. Must be 'upload' or 'download'.")
    local_path = properties.get("localPath", "")
    remote_path = properties.get("remotePath", "")
    timeout = _to_int(properties.get("timeout"), DEFAULT_TIMEOUT)
    max_output = _to_int(properties.get("maxOutput"), DEFAULT_MAX_OUTPUT)
    overwrite = _to_bool(properties.get("overwrite"), False)
    requested_host = properties.get("host", "")

    if not requested_host:
        raise ValueError("Missing required field: host")
    if not local_path:
        raise ValueError("Missing required field: localPath")
    if not remote_path:
        raise ValueError("Missing required field: remotePath")
    if base_dir and not os.path.isabs(local_path):
        local_path = os.path.join(base_dir, local_path)

    sensitive = _is_sensitive_path(local_path) or _is_sensitive_path(remote_path)
    if sensitive:
        raise ValueError(f"SCP path is sensitive: {sensitive}")

    scp_config = get_skill_config("scp", requested_host)
    if not scp_config:
        raise ValueError(f"Host {requested_host} not found in .axle configuration under skill 'scp'")
    host = scp_config.get("host", "")
    port = _to_int(scp_config.get("port"), 22)
    user = scp_config.get("user_name", "")
    password = scp_config.get("pass", "")
    auth_type = scp_config.get("auth_type", "password")
    key_file = scp_config.get("key_file", "")
    if not host:
        raise ValueError("Missing required field host in .axle config")
    if not user:
        raise ValueError("Missing required field user_name in .axle config")
    if auth_type == "password" and not password:
        raise ValueError("Missing required field pass in .axle config")
    if auth_type == "key" and not key_file:
        raise ValueError("Missing required field key_file in .axle config")

    if timeout < 1:
        timeout = DEFAULT_TIMEOUT
    elif timeout > 120:
        timeout = 120
    if max_output < 1:
        max_output = DEFAULT_MAX_OUTPUT
    elif max_output > 10485760:
        max_output = 10485760

    return {
        "action": action,
        "operation": operation,
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "auth_type": auth_type,
        "key_file": key_file,
        "requested_host": requested_host,
        "timeout": timeout,
        "max_output": max_output,
        "overwrite": overwrite,
        "local_path": local_path,
        "remote_path": remote_path,
        "sequential": sequential,
        "prompt": next_prompt,
    }


def _create_sftp_client(host, port, user, password, auth_type, key_file, timeout):
    try:
        import paramiko
    except ImportError:
        raise ImportError("SCP skill requires paramiko. Install: pip install paramiko")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = {
        "hostname": host,
        "port": port,
        "username": user,
        "timeout": timeout,
    }
    if auth_type == "key":
        key_path = os.path.expanduser(key_file)
        if not os.path.exists(key_path):
            raise FileNotFoundError(f"SSH key not found: {key_path}")
        key_types = [paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey]
        key = None
        for key_cls in key_types:
            try:
                key = key_cls.from_private_key_file(key_path, password=password or None)
                break
            except Exception:
                continue
        if key is None:
            raise ValueError(f"Cannot load key: {key_path}")
        connect_kwargs["pkey"] = key
    else:
        connect_kwargs["password"] = password
    client.connect(**connect_kwargs)
    return client


def _ensure_remote_dir(sftp, remote_path):
    remote_dir = os.path.dirname(remote_path)
    if not remote_dir:
        return
    try:
        sftp.stat(remote_dir)
    except FileNotFoundError:
        try:
            sftp.mkdir(remote_dir)
        except OSError:
            pass


def _upload_file(client, local_path, remote_path, timeout):
    try:
        if not os.path.exists(local_path):
            raise FileNotFoundError(f"Local file not found: {local_path}")
        if os.path.isdir(local_path):
            raise ValueError(f"Local path is a directory, not a file: {local_path}")
        file_size = os.path.getsize(local_path)
        sftp = client.open_sftp()
        _ensure_remote_dir(sftp, remote_path)
        sftp.put(local_path, remote_path)
        sftp.close()
        return f"Upload succeeded. Local: {local_path} -> Remote: {remote_path} ({file_size} bytes)"
    except Exception as e:
        return f"Upload failed: {e}"


def _download_file(client, remote_path, local_path, timeout, overwrite):
    try:
        local_dir = os.path.dirname(local_path)
        if local_dir and not os.path.exists(local_dir):
            os.makedirs(local_dir, exist_ok=True)
        if os.path.exists(local_path) and not overwrite:
            return f"Download skipped: local file exists at {local_path}. Set overwrite: true to replace."
        sftp = client.open_sftp()
        try:
            sftp.stat(remote_path)
        except FileNotFoundError:
            raise FileNotFoundError(f"Remote file not found: {remote_path}")
        sftp.get(remote_path, local_path)
        sftp.close()
        file_size = os.path.getsize(local_path)
        return f"Download succeeded. Remote: {remote_path} -> Local: {local_path} ({file_size} bytes)"
    except Exception as e:
        return f"Download failed: {e}"


def execute_scp_from_payload(payload: Union[str, Dict[str, Any]], base_dir: Optional[str] = None) -> str:
    try:
        raw = extract_json(payload)
        data = _normalize(raw, base_dir=base_dir)
    except (ValueError, json.JSONDecodeError) as exc:
        return f"Invalid payload: {exc}"
    try:
        client = _create_sftp_client(
            host=data["host"], port=data["port"], user=data["user"],
            password=data["password"], auth_type=data["auth_type"],
            key_file=data["key_file"], timeout=data["timeout"],
        )
    except Exception as e:
        error_msg = str(e).replace(data["password"], "******") if data["password"] else str(e)
        return f"SCP connection failed: {error_msg}"
    try:
        if data["operation"] == "upload":
            result = _upload_file(client, data["local_path"], data["remote_path"], data["timeout"])
        elif data["operation"] == "download":
            result = _download_file(client, data["remote_path"], data["local_path"], data["timeout"], data["overwrite"])
        else:
            result = f"Unknown operation: {data['operation']}"
    except Exception as e:
        error_msg = str(e).replace(data["password"], "******") if data["password"] else str(e)
        result = f"SCP operation failed: {error_msg}"
    finally:
        try:
            client.close()
        except Exception:
            pass
    seq = data["sequential"]
    return ExecutionResponse(content=result, prompt=data["prompt"], sequential=seq, print=not seq)


def skill_scp_execute(json_payload: str, base_dir: str = "") -> str:
    return execute_scp_from_payload(json_payload, base_dir=base_dir.strip() or None)


__all__ = ["execute_scp_from_payload", "skill_scp_execute"]


@AxleExecutor(action="scp", description="Secure file copy between local and remote hosts over SSH.", version="1.0.0")
def execute_scp(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_scp_execute(json_payload, base_dir)
