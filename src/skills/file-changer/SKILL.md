# ✏️ File Changer Skill

## Overview

This skill enables the LLM to help users **modify existing files** by understanding their intent and producing a **strictly-formatted JSON output** that describes what change to apply. 

Unlike `file-creator` (which creates new files), this skill operates on files that already exist and applies one of several supported change operations.

If the file is too large, the content can be separated into two or more parts for file-changer skill to change the file.

## Skill Name

`file-changer`

## When to Use This Skill

Invoke this skill whenever the user's or LLM decision result request implies modifying an existing file. Look for phrases such as:

- "change the file ..."
- "modify ..."
- "update ..."
- "edit ..."
- "replace <X> with <Y> in <file>"
- "append ... to the file"
- "prepend ... to the file"
- "insert ... into ..."
- "remove ... from the file"
- "rewrite the contents of ..."

The skill applies to any text-based file: source code (`.py`, `.js`, `.java`, `.ts`, `.go`, `.c`, `.cpp`, ...), config (`.json`, `.yaml`, `.toml`, `.ini`, `.env`), markup (`.md`, `.html`, `.xml`), plain text (`.txt`, `.log`), and more.

Do **NOT** use this skill when the user wants to create a brand-new file — use `file-creator` instead.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **filePath** (required): The path to the file to modify (relative or absolute). May be a full path including the filename, or a directory portion.
   - **fileName** (required if not already contained in `filePath`): The final file name including extension.
   - **operation** (required): One of:
     - `replace_all` — Replace the entire file content with `content`.
     - `append` — Append `content` to the end of the file.
     - `prepend` — Insert `content` at the beginning of the file.
     - `replace_text` — Replace occurrences of `search` with `replacement` in the file.
     - `insert_at_line` — Insert `content` at the given 1-based line number (`lineNumber`).
     - `delete_lines` — Delete a range of lines (`startLine` to `endLine`, 1-based inclusive).
   - **content** (conditionally required): New content used by `replace_all`, `append`, `prepend`, and `insert_at_line`.
   - **search** (required for `replace_text`): Text to search for.
   - **replacement** (required for `replace_text`): Text to replace matched `search` with.
   - **lineNumber** (required for `insert_at_line`): 1-based line number.
   - **startLine** / **endLine** (required for `delete_lines`): 1-based inclusive range.
   - **encoding** (optional): Defaults to `utf-8`.
   - **createIfMissing** (optional): `true` to create the file if it does not exist. Defaults to `false`.
   - **backup** (optional): `true` to save a `.bak` copy before modifying. Defaults to `false`. Backup the original only if specified explicitly.
   - **description** (optional): One-line summary of the change.
   - **sequential** (optional): presented if the file change is just one part of LLM decision flows.
   - **prompt** (optional): When `sequential` is presented, this prompt is used to ask the AI to perform all of the follow-up tasks.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```` ``` ````).

```
{
  "action": "change_file",
  "thinking": "<ai-thinking-trace>",
  "properties": [
    { "name": "filePath",        "value": "<directory-or-full-path>" },
    { "name": "fileName",        "value": "<name-with-extension>" },
    { "name": "operation",       "value": "<replace_all|append|prepend|replace_text|insert_at_line|delete_lines>" },
    { "name": "encoding",        "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup",          "value": "false" },
    { "name": "content",         "value": "" },
    { "name": "search",          "value": "" },
    { "name": "replacement",     "value": "" },
    { "name": "lineNumber",      "value": "" },
    { "name": "startLine",       "value": "" },
    { "name": "endLine",         "value": "" }
  ]
}
```

Properties that are not relevant to the chosen `operation` may be omitted or left with an empty string value.

### Field Rules

| Field             | Type    | Required                     | Notes                                                                 |
|-------------------|---------|------------------------------|-----------------------------------------------------------------------|
| `action`          | string  | Yes                          | Must be exactly `"change_file"`.                                      |
| `filePath`        | string  | Yes                          | Directory portion OR full path.                                       |
| `fileName`        | string  | Yes*                         | Filename including extension. May be omitted if included in filePath. |
| `operation`       | string  | Yes                          | One of the supported operations listed above.                         |
| `content`         | string  | Cond.                        | Required for replace_all / append / prepend / insert_at_line.  Need to escape the content as it is in a JSON string.        |
| `search`          | string  | Cond.                        | Required for replace_text.                                            |
| `replacement`     | string  | Cond.                        | Required for replace_text.                                            |
| `lineNumber`      | string  | Cond.                        | Required for insert_at_line (1-based).                                |
| `startLine`       | string  | Cond.                        | Required for delete_lines (1-based inclusive).                        |
| `endLine`         | string  | Cond.                        | Required for delete_lines (1-based inclusive).                        |
| `encoding`        | string  | No                           | Default `utf-8`.                                                      |
| `createIfMissing` | boolean | No                           | Default `false`.                                                      |
| `backup`          | boolean | No                           | Default `false`. When true, writes `<file>.bak` before modifying.     |
| `description`     | string  | No                           | Human-readable purpose of the change.                                 |
| `sequential`    | object | No       | Whether the current action should feed a follow-up AI task. Default null.      |
| `prompt`        | string  | No       | Follow-up prompt for all of the following tasks when `sequential` is presented |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** wrap `content` / `search` / `replacement` in additional Markdown fences — they are plain strings.
- Do **NOT** emit multiple `file-changer` payloads in a single response.
- If the user does not specify a file, do NOT execute this skill — ask for the filename first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

`createIfMissing` and `backup` should only be `"true"` when the user explicitly asks for it.

> {
>   "action": "change_file",
>   "thinking": "User asked to append a new line to notes.txt.",
>   "properties": [
>     { "name": "filePath", "value": "./" },
>     { "name": "fileName", "value": "notes.txt" },
>     { "name": "operation", "value": "append" },
>     { "name": "encoding", "value": "utf-8" },
>     { "name": "createIfMissing", "value": "false" },
>     { "name": "backup", "value": "false" },
>     { "name": "description", "value": "Append a reminder line to notes.txt" },
>     { "name": "content", "value": "Remember to buy milk\n" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply modifying an existing file?
    |     |
    |     +-- YES --> Extract path/name/operation/content --> Emit ONE `file-changer` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill (consider file-creator or file-reader)
```

## Examples

### Example 1: Replace all content
**User:** "Replace everything in `README.md` with the text `# My Project`."

**LLM emits:**
{
  "action": "change_file",
  "thinking": "User asked to fully replace README.md contents.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "README.md" },
    { "name": "operation", "value": "replace_all" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup", "value": "false" },
    { "name": "description", "value": "Rewrite README.md" },
    { "name": "content", "value": "# My Project\n" }
  ]
}

### Example 2: Append a line
**User:** "Add `PORT=8080` at the end of `.env`."

**LLM emits:**
{
  "action": "change_file",
  "thinking": "User wants to append a new env var to .env.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": ".env" },
    { "name": "operation", "value": "append" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup", "value": "false" },
    { "name": "description", "value": "Append PORT variable" },
    { "name": "content", "value": "PORT=8080\n" }
  ]
}

### Example 3: Replace text
**User:** "In `config/app.json`, change `\"debug\": true` to `\"debug\": false`."

**LLM emits:**
{
  "action": "change_file",
  "thinking": "User wants to toggle a JSON flag via text replacement.",
  "properties": [
    { "name": "filePath", "value": "config/" },
    { "name": "fileName", "value": "app.json" },
    { "name": "operation", "value": "replace_text" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup", "value": "false" },
    { "name": "description", "value": "Disable debug flag" },
    { "name": "search", "value": "\"debug\": true" },
    { "name": "replacement", "value": "\"debug\": false" }
  ]
}

### Example 4: Insert at a specific line
**User:** "Insert `import os` at line 2 of `hello.py`."

**LLM emits:**
{
  "action": "change_file",
  "thinking": "User wants to insert a new import statement at line 2.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "hello.py" },
    { "name": "operation", "value": "insert_at_line" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup", "value": "false" },
    { "name": "description", "value": "Add os import" },
    { "name": "lineNumber", "value": "2" },
    { "name": "content", "value": "import os\n" }
  ]
}

### Example 5: Delete lines
**User:** "Delete lines 5 through 10 of `main.py`."

**LLM emits:**
{
  "action": "change_file",
  "thinking": "User wants to delete a specific line range.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "main.py" },
    { "name": "operation", "value": "delete_lines" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "createIfMissing", "value": "false" },
    { "name": "backup", "value": "false" },
    { "name": "description", "value": "Remove lines 5-10" },
    { "name": "startLine", "value": "5" },
    { "name": "endLine", "value": "10" }
  ]
}

## Safety Guidelines

1. Never modify files outside the user's intent (no arbitrary system paths).
2. Refuse suspicious paths (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Do not create new files unless `createIfMissing: true` is set explicitly.
4. Prefer `backup: true` when the user hints at risky or large changes.
5. Always show the JSON payload so the user can review before execution.
