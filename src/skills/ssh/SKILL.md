# 🖥️ SSH Remote Execution Skill (ssh)

## Overview

This skill enables the LLM to execute commands and perform operations on a remote Linux-like system via SSH by understanding the user's intent and producing a **strictly-formatted JSON output** that describes the SSH operation to perform. The JSON output is then parsed by the `ssh` skill to connect to the remote host and return the result.

## Skill Name

`ssh`

## When to Use This Skill

Invoke this skill whenever the user's request implies executing a command on a remote system, transferring files, or interacting with a remote Linux-like host via SSH. Look for phrases such as:

- "ssh to ..."
- "run on the remote server ..."
- "execute on ..."
- "remote command ..."
- "connect to the server and ..."
- "upload file to ..."
- "download file from ..."
- "check the remote ..."
- "deploy to ..."

Do **NOT** use this skill when the user wants to:
- Read a local file → use `file-reader`.
- Create a local file → use `file-creator`.
- Make HTTP requests → use `curl`.
- Execute a local shell command → use `cmd-runner`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **command** (required): The shell command to execute on the remote host.
   - **host** (required): The remote host to connect to (can be specified by a configured host name or direct hostname/IP).
   - **timeout** (optional): Maximum execution time in seconds. Defaults to `30`.
   - **allowDestructive** (optional): Whether to allow destructive commands (rm -rf, shutdown, reboot, etc.). Defaults to `false`.
   - **maxOutput** (optional): Maximum output size shown to user in bytes. Defaults to `1048576` (1MB).
   - **description** (optional): One-line summary of the SSH operation.
   - **operation** (optional): Type of SSH operation. One of `exec` (execute command, default), `upload` (upload file to remote), `download` (download file from remote).
   - **localPath** (conditional): Required for `upload`/`download` operations. Path to the local file.
   - **remotePath** (conditional): Required for `upload`/`download` operations. Path on the remote host.
   - **sequential** (optional): If the result set is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```json
{
  "action": "ssh",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    { "name": "host",             "value": "my-remote-server" },
    { "name": "command",          "value": "ls -la /var/log" },
    { "name": "operation",        "value": "exec" },
    { "name": "timeout",          "value": "30" },
    { "name": "allowDestructive", "value": "false" },
    { "name": "maxOutput",        "value": "1048576" },
    { "name": "description",      "value": "" }
  ]
}
```

### Field Rules

| Field              | Type    | Required | Notes                                                                 |
|--------------------|---------|----------|-----------------------------------------------------------------------|
| `action`           | string  | Yes      | Must be exactly `"ssh"`.                                      |
| `command`          | string  | Yes*     | The shell command to execute on the remote host. Required for `exec` operation. |
| `host`             | string  | Yes      | Remote host name as configured in `.axle` or direct hostname/IP.      |
| `operation`        | string  | No       | One of `exec`, `upload`, `download`. Default `"exec"`.               |
| `timeout`          | string  | No       | Timeout in seconds as string. Default `"30"`. Max `"120"`.          |
| `allowDestructive` | string  | No       | `"true"` or `"false"`. Default `"false"`.                          |
| `maxOutput`        | string  | No       | Maximum output size in bytes. Default `"1048576"` (1MB).             |
| `localPath`        | string  | Cond.    | Required for `upload`/`download` operations. Local file path.         |
| `remotePath`       | string  | Cond.    | Required for `upload`/`download` operations. Remote file path.        |
| `description`      | string  | No       | Human-readable purpose of the SSH operation.                          |
| `sequential`       | object  | No       | If the result should feed a follow-up AI task.                        |
| `prompt`           | string  | No       | Follow-up prompt when `sequential` is present.                        |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\\`, newline as `\\n`, tab as `\\t`).
- Do **NOT** emit multiple `ssh` payloads in a single response.


### SSH Connection Configuration
The SSH configuration should always be in `.axle` in the working directory.
Sample configuration:
```JSON
{
  "skill_configs": [
    {
      "skill": "ssh",
      "config_items": [
        {
          "name": "my-remote-server",
          "value": {
            "host": "192.168.1.100",
            "port": "22",
            "user_name": "admin",
            "auth_type": "password",
            "pass": "encrypted_password_or_plain",
            "key_file": ""
          }
        },
        {
          "name": "production-server",
          "value": {
            "host": "prod.example.com",
            "port": "22",
            "user_name": "deploy",
            "auth_type": "key",
            "pass": "",
            "key_file": "/home/user/.ssh/id_rsa"
          }
        }
      ]
    }
  ]
}
```

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "ssh",
>   "thinking": "User wants to check disk usage on the remote server.",
>   "properties": [
>     { "name": "host",             "value": "my-remote-server" },
>     { "name": "command",          "value": "df -h" },
>     { "name": "operation",        "value": "exec" },
>     { "name": "timeout",          "value": "30" },
>     { "name": "allowDestructive", "value": "false" },
>     { "name": "maxOutput",        "value": "1048576" },
>     { "name": "description",      "value": "Check remote disk usage" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply executing a command on a remote system via SSH?
    |     |
    |     +-- YES --> Extract host/command/operation/flags --> Emit ONE `ssh` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple command execution
**User:** "Run `df -h` on the production server to check disk space."

**LLM emits:**
```json
{
  "action": "ssh",
  "thinking": "User wants to check disk usage on the production server.",
  "properties": [
    { "name": "host", "value": "production-server" },
    { "name": "operation", "value": "exec" },
    { "name": "command", "value": "df -h" },
    { "name": "timeout", "value": "30" },
    { "name": "allowDestructive", "value": "false" },
    { "name": "maxOutput", "value": "1048576" },
    { "name": "description", "value": "Check disk space on production server" }
  ]
}
```

### Example 2: Command with explicit destructive permission
**User:** "Remove the temp folder on the staging server. It's safe to delete."

**LLM emits:**
```json
{
  "action": "ssh",
  "thinking": "User explicitly allows destructive operation, so allowDestructive is true.",
  "properties": [
    { "name": "host", "value": "staging-server" },
    { "name": "operation", "value": "exec" },
    { "name": "command", "value": "rm -rf /tmp/build-cache" },
    { "name": "timeout", "value": "30" },
    { "name": "allowDestructive", "value": "true" },
    { "name": "maxOutput", "value": "1048576" },
    { "name": "description", "value": "Remove temp build cache on staging" }
  ]
}
```

### Example 3: Upload a file
**User:** "Upload the local `deploy.sh` script to the remote server at `/home/admin/deploy.sh`."

**LLM emits:**
```json
{
  "action": "ssh",
  "thinking": "User wants to upload a deployment script to the remote server.",
  "properties": [
    { "name": "host", "value": "my-remote-server" },
    { "name": "operation", "value": "upload" },
    { "name": "localPath", "value": "./deploy.sh" },
    { "name": "remotePath", "value": "/home/admin/deploy.sh" },
    { "name": "timeout", "value": "30" },
    { "name": "allowDestructive", "value": "false" },
    { "name": "description", "value": "Upload deploy script to remote server" }
  ]
}
```

### Example 4: Download a file
**User:** "Download `/var/log/app.log` from the production server to `./logs/app.log`."

**LLM emits:**
```json
{
  "action": "ssh",
  "thinking": "User wants to download a log file from the production server.",
  "properties": [
    { "name": "host", "value": "production-server" },
    { "name": "operation", "value": "download" },
    { "name": "remotePath", "value": "/var/log/app.log" },
    { "name": "localPath", "value": "./logs/app.log" },
    { "name": "timeout", "value": "60" },
    { "name": "allowDestructive", "value": "false" },
    { "name": "description", "value": "Download application log from production" }
  ]
}
```

### Example 5: Long-running command with custom timeout
**User:** "Run a system update on the dev server. It might take up to 2 minutes."

**LLM emits:**
```json
{
  "action": "ssh",
  "thinking": "User expects a long-running operation, extending timeout to 120s.",
  "properties": [
    { "name": "host", "value": "dev-server" },
    { "name": "operation", "value": "exec" },
    { "name": "command", "value": "sudo apt-get update && sudo apt-get upgrade -y" },
    { "name": "timeout", "value": "120" },
    { "name": "allowDestructive", "value": "true" },
    { "name": "maxOutput", "value": "1048576" },
    { "name": "description", "value": "Run system update on dev server" }
  ]
}
```

## Safety Guidelines

1. Never allow destructive commands by default. Destructive commands include: `rm -rf`, `shutdown`, `reboot`, `halt`, `poweroff`, `mkfs`, `dd`, `fdisk`, `parted`, `:(){ :|:& };:` (fork bomb), and any command that could cause data loss or system instability.
2. Block commands that attempt to access sensitive system files (e.g., `/etc/shadow`, `/etc/passwd`, `/root/`, `~/.ssh/`) unless explicitly approved.
3. Enforce a reasonable timeout (default 30s, max 120s).
4. Limit the output size to prevent excessive output (default 1MB max).
5. Always echo the JSON payload so the user can review before execution.
6. The connection details (host, port, user, auth_type, password/key) must be provided in the `.axle` configuration; do not read them from external files without explicit user consent.
7. Do not expose passwords or private keys in logs or error messages; mask them if shown.
8. For `upload` operations, verify the local file exists before attempting transfer.
9. For `download` operations, ensure the local path is writable and does not overwrite existing files without user confirmation.
10. Never allow SSH tunneling or port forwarding unless explicitly requested and approved by the user.
11. Refuse commands that attempt to modify the SSH configuration or install backdoors.
