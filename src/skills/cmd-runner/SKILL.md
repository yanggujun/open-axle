# 🖥️ Command Runner Skill

## Overview

This skill enables the LLM to help users **execute OS shell commands** by producing a **strictly-formatted JSON output** that describes the command to run. The JSON output is then parsed by the `cmd_runner_execute` skill to run the command via `subprocess.run()` and return the output.

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`cmd-runner`

## When to Use This Skill

Invoke this skill whenever the user's request implies executing a shell command. Look for phrases such as:

- "run the command ..."
- "execute ..."
- "run a shell command ..."
- "compile ..."
- "start ..."
- "install ..."
- "check version of ..."
- "run a Python script ..."

Do **NOT** use this skill when the user wants to:
- Create or modify files → use `file-creator` / `file-changer`.
- Read files → use `file-reader`.
- Make HTTP requests → use `curl`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **command** (required): The shell command string to execute.
   - **cwd** (optional): The working directory for the command. Defaults to current working directory (`./`).
   - **timeout** (optional): Maximum execution time in seconds. Defaults to `30`.
   - **shell** (optional): Whether to run via shell. Defaults to `true`.
   - **shelltype** (required): The type of shell to use. Possible values: "bash" (Linux/Unix default), "maccmd" (macOS terminal), "windowsbat" (Windows Command Prompt), "windowsps" (Windows PowerShell). If not specified, the LLM should specify the output command shell type for the skill executor to run.
   - **env** (optional): A dictionary of environment variables to set.
   - **description** (optional): One-line summary of the command.
   - **sequential** (optional): If the output is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of the following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```
{
  "action": "run_command",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "Follow-up prompt for all of the following tasks."
  },
  "properties": [
    { "name": "command",     "value": "<shell-command>" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "one of bash, maccmd, windowsbat, windowsps according to the os" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "" }
  ]
}
```

### Field Rules

| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | Must be exactly `"run_command"`.                                        |
| `command`     | string  | Yes      | The shell command to execute. Must be non-empty.                      |
| `cwd`         | string  | No       | Working directory. Defaults to `./`.                                  |
| `timeout`     | string  | No       | Timeout in seconds as string. Default `"30"`.                        |
| `shell`       | boolean | No       | Use shell to execute. Default `true`.                                 |
| `shelltype`   | string  | No       | Type of shell: "bash", "maccmd", "windowsbat", "windowsps". Defaults to OS-based auto-detect. |
| `env`         | string  | No       | JSON-encoded dictionary of environment variables. Default `"{}"`.   |
| `description` | string  | No       | Human-readable purpose of the command.                                |
| `sequential`  | object  | No       | Whether the output should feed a follow-up AI task. Default null.     |
| `prompt`      | string  | No       | Follow-up prompt for all of following tasks when `sequential` is set. |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- `env` must be a valid JSON object string (e.g., `{"PATH": "/usr/bin"}`).
- Do **NOT** emit multiple `cmd-runner` payloads in a single response.
- If the user does not specify a command, do NOT execute this skill — ask for the command first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "run_command",
>   "thinking": "User wants to list files in the current directory.",
>   "sequential": {
>      "prompt":"Follow-up prompt for all of following tasks"
>    },
>   "properties": [
>     { "name": "command",     "value": "ls -la" },
>     { "name": "cwd",         "value": "./" },
>     { "name": "timeout",     "value": "30" },
>     { "name": "shell",       "value": "true" },
>     { "name": "shelltype",   "value": "bash" },
>     { "name": "env",         "value": "{}" },
>     { "name": "description", "value": "List files with details" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply executing a shell command?
    |     |
    |     +-- YES --> Extract command/cwd/timeout/flags --> Emit ONE `cmd-runner` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple shell command (Linux/macOS)
**User:** "Run `ls -la` in the current directory."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants to list files in the current directory.",
  "properties": [
    { "name": "command",     "value": "ls -la" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "bash" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "List directory contents" }
  ]
}
```

### Example 2: Simple shell command (Windows Command Prompt)
**User:** "Run `dir /w` in the current directory."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants to list files in the current directory using Windows Command Prompt.",
  "properties": [
    { "name": "command",     "value": "dir /w" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "windowsbat" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "List directory contents wide format" }
  ]
}
```

### Example 3: Simple shell command (Windows PowerShell)
**User:** "Run `Get-ChildItem` in the current directory."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants to list files using PowerShell.",
  "properties": [
    { "name": "command",     "value": "Get-ChildItem" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "windowsps" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "List directory contents via PowerShell" }
  ]
}
```

### Example 4: Command with custom working directory
**User:** "Run `make build` in the `projects/myapp` directory."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants to build the project from a specific directory.",
  "properties": [
    { "name": "command",     "value": "make build" },
    { "name": "cwd",         "value": "projects/myapp" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "bash" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "Build the project" }
  ]
}
```

### Example 5: Command with environment variables
**User:** "Run `echo $MY_VAR` with MY_VAR=hello."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants to run a command with custom environment variables.",
  "properties": [
    { "name": "command",     "value": "echo $MY_VAR" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "30" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "bash" },
    { "name": "env",         "value": "{\"MY_VAR\": \"hello\"}" },
    { "name": "description", "value": "Test environment variable" }
  ]
}
```

### Example 6: Long-running command with timeout
**User:** "Run `sleep 60` but timeout after 10 seconds."

**LLM emits:**
```
{
  "action": "run_command",
  "thinking": "User wants a command that might take long, with a short timeout.",
  "properties": [
    { "name": "command",     "value": "sleep 60" },
    { "name": "cwd",         "value": "./" },
    { "name": "timeout",     "value": "10" },
    { "name": "shell",       "value": "true" },
    { "name": "shelltype",   "value": "bash" },
    { "name": "env",         "value": "{}" },
    { "name": "description", "value": "Test timeout" }
  ]
}
```

## Safety Guidelines

1. Never execute commands that could harm the system (e.g., `rm -rf /`, `dd if=/dev/zero of=/dev/sda`, `:(){ :|:& };:`, `format C:`, etc.). Block such commands.
2. Refuse commands that attempt to access sensitive paths (e.g., `C:\Windows\`, `/etc/shadow`, `~/.ssh/`).
3. Enforce a reasonable timeout (default 30s, max 120s).
4. Limit the output size to prevent excessive output (e.g., 1MB max stdout/stderr).
5. Always echo the JSON payload so the user can review before execution.
6. Do not execute commands that modify system configuration or install software without explicit user confirmation.
