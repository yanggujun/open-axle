# 📂 File List Skill

## Overview

This skill enables the LLM to help users **list the files in a given directory** by understanding their intent and producing a **strictly-formatted JSON output** that describes which directory to list. The JSON output can then be parsed by the `file_list_execute` skill to actually read the directory entries from disk.

## Skill Name

`file-list`

## When to Use This Skill

Invoke this skill whenever the user's request implies listing, viewing, or enumerating files in a directory. Look for phrases such as:

- "list files in ..."
- "show all files in ..."
- "what's in the directory ..."
- "enumerate files under ..."
- "Check files in..." 
- "view directory contents ..."
- "get the listing of ..."
- "ls ..." (Unix style)
- "dir ..." (Windows style)

The skill applies to any directory: project folders, subdirectories, etc. Do **NOT** use this skill when the user wants to read a single file's content → use `file-reader`. Do not use it for creating or modifying files.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **directoryPath** (required): The path to the directory to list (relative or absolute). Defaults to `"./"` (current working directory) if not specified.
   - **recursive** (optional): `true` to list files in subdirectories recursively. Defaults to `false`.
   - **includeHidden** (optional): `true` to include hidden files (names starting with `.`). Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to filter filenames (e.g. `*.py`). Defaults to `*` (all files).
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to common noise files like `*.pyc,*.log`.
   - **showDetails** (optional): `true` to include file size and last modified timestamp. Defaults to `false`.
   - **maxResults** (optional): Maximum number of entries to return. Defaults to `500`.
   - **description** (optional): One-line summary of the directory listing task.
   - **sequential** (optional): If the listing result is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```` ``` ````).

```json
{
  "action": "list_files",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    {
      "name": "directoryPath",
      "value": "./"
    },
    {
      "name": "recursive",
      "value": "false"
    },
    {
      "name": "includeHidden",
      "value": "false"
    },
    {
      "name": "includeGlob",
      "value": "*"
    },
    {
      "name": "excludeGlob",
      "value": ""
    },
    {
      "name": "showDetails",
      "value": "false"
    },
    {
      "name": "maxResults",
      "value": "500"
    },
    {
      "name": "description",
      "value": "List files in the given directory"
    }
  ]
}
```

### Field Rules

| Field           | Type    | Required | Notes                                                                                |
|-----------------|---------|----------|--------------------------------------------------------------------------------------|
| `action`        | string  | Yes      | Must be exactly `"list_files"`.                                                      |
| `directoryPath` | string  | Yes      | Directory to list. Default `"./"`.                                                   |
| `recursive`     | boolean | No       | List files in subdirectories. Default `false`.                                       |
| `includeHidden` | boolean | No       | Include files whose names start with `.`. Default `false`.                            |
| `includeGlob`   | string  | No       | Glob pattern to include. Default `"*"`.                                              |
| `excludeGlob`   | string  | No       | Comma-separated globs to exclude. Default `""` (no exclusion).                      |
| `showDetails`   | boolean | No       | Show file size and modification time. Default `false`.                               |
| `maxResults`    | string  | No       | Integer as string. Default `"500"`.                                                  |
| `description`   | string  | No       | Human-readable purpose of the listing.                                               |
| `sequential`    | object  | No       | Whether the listing result should feed a follow-up AI task. Default null.            |
| `prompt`        | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented.                                |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `file-list` payloads in a single response.
- If the user does not specify a directory, default to `./`.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "list_files",
>   "thinking": "User asked to list files in the current directory.",
>   "properties": [
>     { "name": "directoryPath", "value": "./" },
>     { "name": "recursive", "value": "false" },
>     { "name": "includeHidden", "value": "false" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": "" },
>     { "name": "showDetails", "value": "false" },
>     { "name": "maxResults", "value": "500" },
>     { "name": "description", "value": "List current directory contents" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply listing/enumerating files in a directory?
    |     |
    |     +-- YES --> Extract dir path/flags --> Emit ONE `file-list` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple listing in current directory
**User:** "List all files in the current directory."

**LLM emits:**
```json
{
  "action": "list_files",
  "thinking": "User wants a simple flat listing of the current directory.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "false" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List files in ./" }
  ]
}
```

### Example 2: Recursive listing with glob filter
**User:** "Show me all Python files under `src/` recursively."

**LLM emits:**
```json
{
  "action": "list_files",
  "thinking": "User wants all .py files in src/ recursively.",
  "properties": [
    { "name": "directoryPath", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*.py" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "false" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List Python files in src/" }
  ]
}
```

### Example 3: Listing with details
**User:** "Show me all files in the project root with their sizes."

**LLM emits:**
```json
{
  "action": "list_files",
  "thinking": "User wants file details (size, time) for root directory.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "true" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List files with details" }
  ]
}
```

## Safety Guidelines

1. Never list files outside the user's intent (no arbitrary system paths).
2. Refuse suspicious paths (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Cap the number of files returned via `maxResults` to avoid enormous output.
4. Do not recurse into blocked directories.
5. Always echo the JSON payload so the user can review before execution.