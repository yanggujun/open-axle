from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional, Union

from executor import AxleExecutor, ExecutionResponse, extract_json, get_skill_config, getSequential


DEFAULT_TIMEOUT = 30
DEFAULT_MAX_OUTPUT = 1048576


def _is_dangerous_command(command: str) -> Optional[str]:
    if not command or not command.strip():
        return None
    normalized = command.strip()
    normalized_lower = normalized.lower()
    dangerous_patterns = [
        "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf .",
        "dd if=", "> /dev/sda", "> /dev/hda",
        ":(){ :|:& };:", "chmod 777 /", "chmod -R 777 /",
    ]
    for pattern in dangerous_patterns:
        if pattern.lower() in normalized_lower:
            return f"destructive pattern: {pattern}"
    dangerous_commands = [
        "rm", "shutdown", "reboot", "halt", "poweroff",
        "mkfs", "dd", "fdisk", "kill", "killall",
        "chmod", "chown", "useradd", "userdel", "passwd",
    ]
    first_word = normalized_lower.split()[0] if normalized_lower.split() else ""
    if first_word in dangerous_commands:
        return f"destructive command: {first_word}"
    return None


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


def _normalize(payload: Dict[str, Any], base_dir: Optional[str] = None) -> Dict[str, Any]:
    action = payload.get("action", "ssh")
    sequential, next_prompt = getSequential(payload)
    if action != "ssh":
        raise ValueError(f"Unsupported action: {action!r}")
    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    operation = properties.get("operation", "exec").strip().lower()
    command = properties.get("command", "")
    timeout = _to_int(properties.get("timeout"), DEFAULT_TIMEOUT)
    allow_destructive = _to_bool(properties.get("allowDestructive"), False)
    max_output = _to_int(properties.get("maxOutput"), DEFAULT_MAX_OUTPUT)
    requested_host = properties.get("host", "")
    local_path = properties.get("localPath", "")
    remote_path = properties.get("remotePath", "")
    if not requested_host:
        raise ValueError("Missing required field: host")
    if operation not in ("exec", "upload", "download"):
        raise ValueError(f"Invalid operation: {operation}")
    if operation == "exec" and not command:
        raise ValueError("Missing required field: command for exec operation")
    if operation == "upload":
        if not local_path:
            raise ValueError("Missing required field: localPath for upload")
        if not remote_path:
            raise ValueError("Missing required field: remotePath for upload")
        if base_dir and not os.path.isabs(local_path):
            local_path = os.path.join(base_dir, local_path)
    if operation == "download":
        if not local_path:
            raise ValueError("Missing required field: localPath for download")
        if not remote_path:
            raise ValueError("Missing required field: remotePath for download")
        if base_dir and not os.path.isabs(local_path):
            local_path = os.path.join(base_dir, local_path)
    ssh_config = get_skill_config("ssh", requested_host)
    if not ssh_config:
        raise ValueError(f"Host {requested_host} not found in .axle configuration")
    host = ssh_config.get("host", "")
    port = _to_int(ssh_config.get("port"), 22)
    user = ssh_config.get("user_name", "")
    password = ssh_config.get("pass", "")
    auth_type = ssh_config.get("auth_type", "password")
    key_file = ssh_config.get("key_file", "")
    if not host:
        raise ValueError("Missing required field host in .axle config")
    if not user:
        raise ValueError("Missing required field user_name in .axle config")
    if auth_type == "password" and not password:
        raise ValueError("Missing required field pass in .axle config")
    if auth_type == "key" and not key_file:
        raise ValueError("Missing required field key_file in .axle config")
    if operation == "exec" and not allow_destructive:
        dangerous = _is_dangerous_command(command)
        if dangerous:
            raise ValueError(f"SSH command is destructive: {dangerous}. Set allowDestructive: true.")
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
        "command": command,
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "auth_type": auth_type,
        "key_file": key_file,
        "requested_host": requested_host,
        "timeout": timeout,
        "allow_destructive": allow_destructive,
        "max_output": max_output,
        "local_path": local_path,
        "remote_path": remote_path,
        "sequential": sequential,
        "prompt": next_prompt,
    }


def _create_ssh_client(host, port, user, password, auth_type, key_file, timeout):
    try:
        import paramiko
    except ImportError :
        raise ImportError("SSH skill requires paramiko. Install: pip install paramiko")
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


def _execute_ssh_command(client, command, timeout, max_output):
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out_data = stdout.read(max_output)
        err_data = stderr.read(max_output)
        out_str = out_data.decode("utf-8", errors="replace")
        err_str = err_data.decode("utf-8", errors="replace")
        result = f"SSH command completed (exit: {exit_code})\n"
        if out_str.strip():
            result += "--- stdout ---\n" + out_str.rstrip() + "\n"
        if err_str.strip():
            result += "--- stderr ---\n" + err_str.rstrip() + "\n"
        return result
    except Exception as e:
        return f"SSH command failed: {e}"


def _upload_file(client, local_path, remote_path, timeout):
    try:
        if not os.path.exists(local_path):
            raise FileNotFoundError(f"Local file not found: {local_path}")
        file_size = os.path.getsize(local_path)
        sftp = client.open_sftp()
        remote_dir = os.path.dirname(remote_path)
        if remote_dir:
            try:
                sftp.stat(remote_dir)
            except FileNotFoundError:
                client.exec_command(f"mkdir -p {remote_dir}", timeout=timeout)
        sftp.put(local_path, remote_path)
        sftp.close()
        return f"Upload succeeded. Local: {local_path} -> Remote: {remote_path} ({file_size} bytes)"
    except Exception as e:
        return f"Upload failed: {e}"


def _download_file(client, remote_path, local_path, timeout):
    try:
        local_dir = os.path.dirname(local_path)
        if local_dir and not os.path.exists(local_dir):
            os.makedirs(local_dir, exist_ok=True)
        if os.path.exists(local_path):
            return f"Download skipped: local file exists at {local_path}"
        sftp = client.open_sftp()
        sftp.get(remote_path, local_path)
        sftp.close()
        file_size = os.path.getsize(local_path)
        return f"Download succeeded. Remote: {remote_path} -> Local: {local_path} ({file_size} bytes)"
    except Exception as e:
        return f"Download failed: {e}"


def execute_ssh_from_payload(payload: Union[str, Dict[str, Any]], base_dir: Optional[str] = None) -> str:
    try:
        raw = extract_json(payload)
        data = _normalize(raw, base_dir=base_dir)
    except (ValueError, json.JSONDecodeError) as exc:
        return f"Invalid payload: {exc}"
    try:
        client = _create_ssh_client(
            host=data["host"], port=data["port"], user=data["user"],
            password=data["password"], auth_type=data["auth_type"],
            key_file=data["key_file"], timeout=data["timeout"],
        )
    except Exception as e:
        error_msg = str(e).replace(data["password"], "******") if data["password"] else str(e)
        return f"SSH connection failed: {error_msg}"
    try:
        if data["operation"] == "exec":
            result = _execute_ssh_command(client, data["command"], data["timeout"], data["max_output"])
        elif data["operation"] == "upload":
            result = _upload_file(client, data["local_path"], data["remote_path"], data["timeout"])
        elif data["operation"] == "download":
            result = _download_file(client, data["remote_path"], data["local_path"], data["timeout"])
        else:
            result = f"Unknown operation: {data['operation']}"
    except Exception as e:
        error_msg = str(e).replace(data["password"], "******") if data["password"] else str(e)
        result = f"SSH operation failed: {error_msg}"
    finally:
        try:
            client.close()
        except Exception:
            pass
    seq = data["sequential"]
    return ExecutionResponse(content=result, prompt=data["prompt"], sequential=seq, print=not seq)


def skill_ssh_execute(json_payload: str, base_dir: str = "") -> str:
    return execute_ssh_from_payload(json_payload, base_dir=base_dir.strip() or None)


__all__ = ["execute_ssh_from_payload", "skill_ssh_execute"]


@AxleExecutor(action="ssh", description="SSH operations on remote Linux systems.", version="1.0.0")
def execute_ssh(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_ssh_execute(json_payload, base_dir)
