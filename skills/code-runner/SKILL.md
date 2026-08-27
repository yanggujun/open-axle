# 🐍 Code Runner Skill

## Overview

This skill enables the LLM to help users **execute Python scripts** located in the file system by producing a **strictly-formatted JSON output** that describes the script to run. The JSON output is then parsed by the `code_runner_execute` skill to run the script via `subprocess.run()` and return the output.

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`code-runner`

## When to Use This Skill

Invoke this skill whenever the user's request implies executing a Python script. Look for phrases such as:

- "run the script ..."
- "execute ..."
- "run a Python script ..."
- "run this code ..."
- "python ..."
- "call the script ..."

Do **NOT** use this skill when the user wants to:
- Create or modify files → use `file-creator` / `file-changer`.
- Read files → use `file-reader`.
- Make HTTP requests → use `curl`.
- Execute a raw shell command that is not a Python script → use `cmd-runner`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **scriptPath** or **fileName** (required): The path (directory + filename) of the Python script to execute.
   - **method** (optional): The execution method. Defaults to `script` (running the whole script) when method is empty. Possible values: `script` (default), `function` (run a specific function).
   - **args** (optional): Command-line arguments to pass to the script (or the target function/statement name when method is `function`/`statement`).
   - **timeout** (optional): Maximum execution time in seconds. Defaults to `30`.
   - **shelltype** (optional): The type of shell used to invoke Python. Possible values: "bash" (Linux/Unix default), "maccmd" (macOS terminal), "windowsbat" (Windows Command Prompt), "windowsps" (Windows PowerShell). If not specified, auto-detect based on the OS.
   - **env** (optional): A dictionary of environment variables to set.
   - **description** (optional): One-line summary of the task.
   - **sequential** (optional): If the output is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of the following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```
{
  "action": "run_code_script",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "Follow-up prompt for all of the following tasks."
  },
  "properties": [
    { "name": "scriptPath", "value": "path/to/script.py" },
    { "name": "fileName",   "value": "script.py" },
    { "name": "args",       "value": "" },
    { "name": "timeout",    "value": "30" },
    { "name": "shelltype",  "value": "one of bash, maccmd, windowsbat, windowsps according to the os" },
    { "name": "env",        "value": "{}" },
    { "name": "description","value": "" }
  ]
}
```

### Field Rules

| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | Must be exactly `"run_code_script"`.                                  |
| `scriptPath`  | string  | Yes      | The directory portion of the script path, or full path. Must be non-empty. |
| `fileName`    | string  | Yes      | The Python file name including `.py`. May be omitted if included in `scriptPath`. |
| `method`      | string  | No       | Execution method: `script` (default), `function`|
| `args`        | string  | No       | Command-line arguments passed to the script, or target name for `function`/`statement`. |
| `timeout`     | string  | No       | Timeout in seconds as string. Default `"30"`. Max `"120"`.             |
| `shelltype`   | string  | No       | Type of shell: "bash", "maccmd", "windowsbat", "windowsps". Defaults to OS-based auto-detect. |
| `env`         | string  | No       | JSON-encoded dictionary of environment variables. Default `"{}"`.      |
| `description` | string  | No       | Human-readable purpose of the execution.                               |
| `sequential`  | object  | No       | Whether the output should feed a follow-up AI task. Default null.      |
| `prompt`      | string  | No       | Follow-up prompt for all of following tasks when `sequential` is set.  |


### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- `env` must be a valid JSON object string (e.g., `{"PATH": "/usr/bin"}`).
- Do **NOT** emit multiple `code-runner` payloads in a single response.
- If the user does not specify a script path, do NOT execute this skill — ask for the script path first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "run_code_script",
>   "thinking": "User wants to run a Python script.",
>   "sequential": {
>      "prompt":"Follow-up prompt for all of following tasks"
>    },
>   "properties": [
>     { "name": "scriptPath", "value": "./scripts/" },
>     { "name": "fileName",   "value": "hello.py" },
>     { "name": "args",       "value": "" },
>     { "name": "timeout",    "value": "30" },
>     { "name": "shelltype",  "value": "bash" },
>     { "name": "env",        "value": "{}" },
>     { "name": "description","value": "Run hello.py" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply executing a Python script?
    |     |
    |     +-- YES --> Extract scriptPath/fileName/method/args/timeout/flags --> Emit ONE `code-runner` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple script run (Linux/macOS)
**User:** "Run `scripts/hello.py`."

**LLM emits:**
```
{
  "action": "run_code_script",
  "thinking": "User wants to run a Python script.",
  "properties": [
    { "name": "scriptPath", "value": "scripts/" },
    { "name": "fileName",   "value": "hello.py" },
    { "name": "method",     "value": "run" },
    { "name": "args",       "value": "" },
    { "name": "timeout",    "value": "30" },
    { "name": "shelltype",  "value": "bash" },
    { "name": "env",        "value": "{}" },
    { "name": "description", "value": "Run hello.py" }
  ]
}
```

### Example 2: Script run with arguments
**User:** "Run `tools/parse.py` with arguments `--input data.txt`."

**LLM emits:**
```
{
  "action": "run_code_script",
  "thinking": "User wants to run a Python script with command-line arguments.",
  "properties": [
    { "name": "scriptPath", "value": "tools/" },
    { "name": "fileName",   "value": "parse.py" },
    { "name": "args",       "value": "--input data.txt" },
    { "name": "timeout",    "value": "30" },
    { "name": "shelltype",  "value": "bash" },
    { "name": "env",        "value": "{}" },
    { "name": "description", "value": "Run parse.py with arguments" }
  ]
}
```

### Example 3: Script run with environment variables
**User:** "Run `env_test.py` with MY_VAR=hello."

**LLM emits:**
```
{
  "action": "run_code_script",
  "thinking": "User wants to run a script with custom environment variables.",
  "properties": [
    { "name": "scriptPath", "value": "./" },
    { "name": "fileName",   "value": "env_test.py" },
    { "name": "args",       "value": "" },
    { "name": "timeout",    "value": "30" },
    { "name": "shelltype",  "value": "bash" },
    { "name": "env",        "value": "{\"MY_VAR\": \"hello\"}" },
    { "name": "description", "value": "Test environment variable" }
  ]
}
```

### Example 4: Long-running script with timeout
**User:** "Run `long_task.py` but timeout after 10 seconds."

**LLM emits:**
```
{
  "action": "run_code_script",
  "thinking": "User wants a script that might take long, with a short timeout.",
  "properties": [
    { "name": "scriptPath", "value": "./" },
    { "name": "fileName",   "value": "long_task.py" },
    { "name": "args",       "value": "" },
    { "name": "timeout",    "value": "10" },
    { "name": "shelltype",  "value": "bash" },
    { "name": "env",        "value": "{}" },
    { "name": "description", "value": "Test timeout" }
  ]
}
```

### Example 5: Execute a specific function
**User:** "Run the function `main` in `utils.py`."

**LLM emits:**
```
{
  "action": "run_code_script",
  "thinking": "User wants to execute a specific function in a Python script.",
  "properties": [
    { "name": "scriptPath", "value": "./" },
    { "name": "fileName",   "value": "utils.py" },
    { "name": "method",     "value": "function" },
    { "name": "args",       "value": "main" },
    { "name": "timeout",    "value": "30" },
    { "name": "shelltype",  "value": "bash" },
    { "name": "env",        "value": "{}" },
    { "name": "description", "value": "Run main() function in utils.py" }
  ]
}
```

## Safety Guidelines

1. Never execute Python scripts that could harm the system (e.g., scripts containing `os.remove`, `shutil.rmtree`, `subprocess` calls to `rm -rf /`, `dd`, `format C:`, fork bombs, etc.). Block such scripts.
2. Refuse scripts that attempt to access sensitive paths (e.g., `C:\Windows\`, `/etc/shadow`, `~/.ssh/`).
3. Enforce a reasonable timeout (default 30s, max 120s).
4. Limit the output size to prevent excessive output (e.g., 1MB max stdout/stderr).
5. Always echo the JSON payload so the user can review before execution.
6. Do not execute scripts that modify system configuration or install software without explicit user confirmation.

## Executable Skills

### `code_runner_execute`
Parses a `code-runner` JSON payload and executes the Python script.

**Parameters:**
- `json_payload` (str): The JSON string produced by the LLM.

**Behavior:**
- Validates the schema (including `shelltype` if provided).
- Checks for dangerous script contents and refuses to execute them.
- Resolves the script path using `scriptPath` and `fileName`.
- Uses the specified `shelltype` to determine the appropriate shell executable for invoking Python:
  - `"bash"` → runs with `/bin/bash` (or `bash` on PATH).
  - `"maccmd"` → runs with `/bin/zsh` (macOS default).
  - `"windowsbat"` → runs with `cmd.exe`.
  - `"windowsps"` → runs with `powershell.exe`.
  - If not specified, auto-detects based on `sys.platform`.
- Runs `python <scriptPath/fileName> <args>` via `subprocess.run()`.
- Supports execution methods: `run` (whole script), `function` (specific function), `statement` (specific statement/expression).
- Sets environment variables if `env` is provided.
- Enforces timeout.
- Returns a JSON string containing `stdout`, `stderr`, and `returncode`.
[axle] 2026-08-22 11:12:37
continue: False
[axle] 2026-08-22 11:12:37
result:
User Prompt
    |
    +-- Does the request imply executing a Python script?
    |     |
    |     +-- YES --> Extract scriptPath/fileName/method/args/timeout/flags --> Emit ONE `code-runner` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill

