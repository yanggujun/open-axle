# 📁 SCP Remote File Copy Skill (scp)

## Overview

This skill enables the LLM to securely copy files between local and remote hosts over SSH, providing functionality equivalent to the Linux `scp` tool. The skill produces a **strictly-formatted JSON output** that describes the file copy operation. The JSON output is then parsed by the `scp` skill to connect to the remote host via SSH and perform the transfer.

## Skill Name

`scp`

## When to Use This Skill

Invoke this skill whenever the user's request implies copying files between local and remote hosts over SSH. Look for phrases such as:

- "copy file to remote ..."
- "upload file to server ..."
- "download file from server ..."
- "secure copy ..."
- "scp ..."
- "transfer file to/from ..."
- "send file to remote host ..."
- "get file from remote host ..."

Do **NOT** use this skill when the user wants to:
- Read a local file → use `file-reader`.
- Create a local file → use `file-creator`.
- Make HTTP requests → use `curl`.
- Execute a shell command on a remote host → use `ssh`.
- Execute a local shell command → use `cmd-runner`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **operation** (required): The copy direction. One of `upload` (local to remote) or `download` (remote to local).
   - **host** (required): The remote host to connect to (must be a configured host name in `.axle`).
   - **localPath** (required): Path to the local file. Required for both operations.
   - **remotePath** (required): Path on the remote host. Required for both operations.
   - **timeout** (optional): Maximum execution time in seconds. Defaults to `30`. Max `120`.
   - **maxOutput** (optional): Maximum output size shown to user in bytes. Defaults to `1048576` (1MB).
   - **overwrite** (optional): Whether to overwrite an existing local file during `download`. Defaults to `false`.
   - **description** (optional): One-line summary of the copy operation.
   - **sequential** (optional): If the result is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```json
{
  "action": "scp",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    { "name": "operation",   "value": "upload" },
    { "name": "host",        "value": "my-remote-server" },
    { "name": "localPath",   "value": "./file.txt" },
    { "name": "remotePath",  "value": "/home/admin/file.txt" },
    { "name": "timeout",     "value": "30" },
    { "name": "maxOutput",   "value": "1048576" },
    { "name": "overwrite",   "value": "false" },
    { "name": "description", "value": "Upload file to remote server" }
  ]
}
```

### Field Rules

| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | Must be exactly `"scp"`.                                              |
| `operation`   | string  | Yes      | One of `upload`, `download`.                                          |
| `host`        | string  | Yes      | Remote host name as configured in `.axle`.                            |
| `localPath`   | string  | Yes      | Local file path. Required for both operations.                        |
| `remotePath`  | string  | Yes      | Remote file path. Required for both operations.                       |
| `timeout`     | string  | No       | Timeout in seconds. Default `"30"`. Max `"120"`.                     |
| `maxOutput`   | string  | No       | Maximum output size in bytes. Default `"1048576"` (1MB).              |
| `overwrite`   | string  | No       | `"true"` or `"false"`. Default `"false"`.                           |
| `description` | string  | No       | Human-readable purpose of the copy operation.                         |
| `sequential`  | object  | No       | If the result should feed a follow-up AI task.                        |
| `prompt`      | string  | No       | Follow-up prompt when `sequential` is present.                        |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `scp` payloads in a single response.

### SCP Connection Configuration

The SCP configuration should always be in `.axle` in the working directory.

Sample configuration:
```JSON
{
  "skill_configs": [
    {
      "skill": "scp",
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
>   "action": "scp",
>   "thinking": "User wants to upload a local file to the remote server.",
>   "properties": [
>     { "name": "operation",   "value": "upload" },
>     { "name": "host",        "value": "my-remote-server" },
>     { "name": "localPath",   "value": "./data.csv" },
>     { "name": "remotePath",  "value": "/home/admin/data.csv" },
>     { "name": "timeout",     "value": "30" },
>     { "name": "maxOutput",   "value": "1048576" },
>     { "name": "overwrite",   "value": "false" },
>     { "name": "description", "value": "Upload data.csv to remote" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply copying files between local and remote hosts over SSH?
    |     |
    |     +-- YES --> Extract operation/host/localPath/remotePath/flags --> Emit ONE `scp` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Upload a file

**User:** "Copy `./deploy.sh` to the production server at `/home/deploy/deploy.sh`."

**LLM emits:**
```json
{
  "action": "scp",
  "thinking": "User wants to upload a local file to the remote server.",
  "properties": [
    { "name": "operation",   "value": "upload" },
    { "name": "host",        "value": "production-server" },
    { "name": "localPath",   "value": "./deploy.sh" },
    { "name": "remotePath",  "value": "/home/deploy/deploy.sh" },
    { "name": "timeout",     "value": "30" },
    { "name": "maxOutput",   "value": "1048576" },
    { "name": "overwrite",   "value": "false" },
    { "name": "description", "value": "Upload deploy script" }
  ]
}
```

### Example 2: Download a file

**User:** "Download `/var/log/app.log` from the production server to `./logs/app.log`."

**LLM emits:**
```json
{
  "action": "scp",
  "thinking": "User wants to download a remote file to the local machine.",
  "properties": [
    { "name": "operation",   "value": "download" },
    { "name": "host",        "value": "production-server" },
    { "name": "remotePath",  "value": "/var/log/app.log" },
    { "name": "localPath",   "value": "./logs/app.log" },
    { "name": "timeout",     "value": "60" },
    { "name": "maxOutput",   "value": "1048576" },
    { "name": "overwrite",   "value": "true" },
    { "name": "description", "value": "Download application log" }
  ]
}
```

### Example 3: Long transfer with custom timeout

**User:** "Transfer a large backup file to the backup server. It may take up to 2 minutes."

**LLM emits:**
```json
{
  "action": "scp",
  "thinking": "User expects a long transfer, extending timeout to 120s.",
  "properties": [
    { "name": "operation",   "value": "upload" },
    { "name": "host",        "value": "backup-server" },
    { "name": "localPath",   "value": "./backup.tar.gz" },
    { "name": "remotePath",  "value": "/backups/backup.tar.gz" },
    { "name": "timeout",     "value": "120" },
    { "name": "maxOutput",   "value": "1048576" },
    { "name": "overwrite",   "value": "false" },
    { "name": "description", "value": "Upload large backup" }
  ]
}
```

## Safety Guidelines

1. Never allow destructive operations. SCP does not execute remote shell commands; do not enable command execution or deletion.
2. Do not overwrite existing local files on `download` unless `overwrite` is explicitly set to `true`.
3. Verify the local file exists before upload.
4. Refuse transfers involving sensitive system files (e.g., `/etc/shadow`, `/etc/passwd`, `/root/`, `~/.ssh/`) unless explicitly approved.
5. Enforce a reasonable timeout (default 30s, max 120s).
6. Limit the output size to prevent excessive output (default 1MB max).
7. Always echo the JSON payload so the user can review before execution.
8. Connection details (host, port, user, auth_type, password/key) must be provided in the `.axle` configuration; do not read them from external files without explicit user consent.
9. Do not expose passwords or private keys in logs or error messages; mask them if shown.
10. Ensure the remote directory exists or is creatable before upload; do not use unsafe shell expansion.
11. Refuse transfers that modify SSH configuration or install backdoors.
