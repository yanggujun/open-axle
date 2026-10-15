# 📂 FS List Skill

## Overview

This skill enables the LLM to help users **list files and/or folders in a given directory** (equivalent to the Linux bash `ls` / Windows `dir` tools) by understanding their intent and producing a **strictly-formatted JSON output** that describes which directory to list. The JSON output is then parsed by the `fs_list_execute` skill to actually read the directory entries from disk.

## Skill Name

`fs-list`

## When to Use This Skill

Invoke this skill whenever the user's request implies listing, viewing, or enumerating files, folders, or both in a directory. Look for phrases such as:

- "list files in ..."
- "list folders in ..."
- "list everything in ..."
- "show all files/folders in ..."
- "what's in the directory ..."
- "enumerate entries under ..."
- "check files in ..."
- "view directory contents ..."
- "get the listing of ..."
- "ls ..." (Unix style)
- "dir ..." (Windows style)

The skill applies to any directory: project folders, subdirectories, etc. Do **NOT** use this skill when the user wants to read a single file's content → use `file-reader`. Do not use it for creating or modifying files.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **directoryPath** (required): The path to the directory to list (relative or absolute). Defaults to `"./"` (current working directory) if not specified.
   - **entryType** (optional): What to list: `file` (files only), `folder` (directories only), or `both` (files and folders). Defaults to `both` — the standard `ls` behavior.
   - **recursive** (optional): `true` to list entries in subdirectories recursively. Defaults to `false`.
   - **includeHidden** (optional): `true` to include hidden entries (names starting with `.`). Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to filter entry names (e.g. `*.py`). Defaults to `*` (all entries).
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to `""` (no exclusion).
   - **showDetails** (optional): `true` to include per-entry type, size and last modified timestamp. Defaults to `false`.
   - **maxResults** (optional): Maximum number of entries to return. Defaults to `500`.
   - **description** (optional): One-line summary of the listing task.
   - **sequential** (optional): If the listing result is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of the following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```).

```json
{
  "action": "list_fs",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "Follow-up prompt for all of following tasks"
  },
  "properties": [
    {
      "name": "directoryPath",
      "value": "./"
    },
    {
      "name": "entryType",
      "value": "both"
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
      "value": "List files and/or folders in the given directory"
    }
  ]
}
```

### Field Rules

| Field           | Type    | Required | Notes                                                                                |
|-----------------|---------|----------|--------------------------------------------------------------------------------------|
| `action`        | string  | Yes      | Must be exactly `"list_fs"`.                                                         |
| `directoryPath` | string  | Yes      | Directory to list. Default `"./"`.                                                   |
| `entryType`     | string  | No       | One of `file`, `folder`, or `both`. Default `both` (standard `ls` behavior).         |
| `recursive`     | boolean | No       | List entries in subdirectories. Default `false`.                                     |
| `includeHidden` | boolean | No       | Include entries whose names start with `.`. Default `false`.                         |
| `includeGlob`   | string  | No       | Glob pattern to include. Default `"*"`.                                              |
| `excludeGlob`   | string  | No       | Comma-separated globs to exclude. Default `""` (no exclusion).                       |
| `showDetails`   | boolean | No       | Show per-entry type, size and modification time. Default `false`.                    |
| `maxResults`    | string  | No       | Integer as string. Default `"500"`.                                                  |
| `description`   | string  | No       | Human-readable purpose of the listing.                                               |
| `sequential`    | object  | No       | Whether the listing result should feed a follow-up AI task. Default null.            |
| `prompt`        | string  | No       | Follow-up prompt for all of the following tasks when `sequential` is presented.      |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `fs-list` payloads in a single response.
- If the user does not specify a directory, default to `./`.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "list_fs",
>   "thinking": "User asked to list the contents of the current directory.",
>   "properties": [
>     { "name": "directoryPath", "value": "./" },
>     { "name": "entryType", "value": "both" },
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
    +-- Does the request imply listing/enumerating files and/or folders in a directory?
    |     |
    |     +-- YES --> Extract dir path/entryType/flags --> Emit ONE `fs-list` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple listing of files and folders in the current directory (like bare `ls`)
**User:** "List everything in the current directory."

**LLM emits:**
```json
{
  "action": "list_fs",
  "thinking": "User wants a simple flat listing of files and folders in the current directory.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "entryType", "value": "both" },
    { "name": "recursive", "value": "false" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "false" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List files and folders in ./" }
  ]
}
```

### Example 2: Only folders, recursive, with glob filter
**User:** "Show me all folders named `src*` under the project recursively."

**LLM emits:**
```json
{
  "action": "list_fs",
  "thinking": "User wants only folders matching src* recursively.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "entryType", "value": "folder" },
    { "name": "recursive", "value": "true" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "src*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "false" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List src* folders recursively" }
  ]
}
```

### Example 3: Only Python files, recursive, with details
**User:** "Show me all Python files under `src/` with their sizes."

**LLM emits:**
```json
{
  "action": "list_fs",
  "thinking": "User wants only .py files with details under src/.",
  "properties": [
    { "name": "directoryPath", "value": "src/" },
    { "name": "entryType", "value": "file" },
    { "name": "recursive", "value": "true" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*.py" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "true" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List Python files with details" }
  ]
}
```

## Safety Guidelines

1. Never list entries outside the user's intent (no arbitrary system paths).
2. Refuse suspicious paths (e.g., `C:\\Windows\\`, `/etc/`, `~/.ssh/`).
3. Cap the number of entries returned via `maxResults` to avoid enormous output.
4. Do not recurse into blocked directories.
5. Always echo the JSON payload so the user can review before execution.
