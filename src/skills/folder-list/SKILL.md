# 📂 Folder List Skill

## Overview

This skill enables the LLM to help users **list folders (subdirectories) in a given directory** by understanding their intent and producing a **strictly-formatted JSON output** that describes which directory to list. The JSON output can then be parsed by the `folder_list_execute` skill to actually read the directory entries from disk.

## Skill Name

`folder-list`

## When to Use This Skill

Invoke this skill whenever the user's request implies listing, viewing, or enumerating folders/subdirectories in a directory. Look for phrases such as:

- "list folders in ..."
- "show all directories in ..."
- "what subfolders are in ..."
- "enumerate folders under ..."
- "view directory structure ..."
- "get the folder listing of ..."
- "list only directories ..."

The skill applies to any directory. Do **NOT** use this skill when the user wants to list files (use `file-list`) or read a single file's content (use `file-reader`).

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **directoryPath** (required): The path to the directory to list (relative or absolute). Defaults to `"./"` (current working directory) if not specified.
   - **recursive** (optional): `true` to list subdirectories recursively. Defaults to `false`.
   - **includeHidden** (optional): `true` to include hidden folders (names starting with `.`). Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to filter folder names (e.g. `src*`). Defaults to `*` (all folders).
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to `""` (no exclusion).
   - **showDetails** (optional): `true` to include folder size and last modified timestamp. Defaults to `false`.
   - **maxResults** (optional): Maximum number of entries to return. Defaults to `500`.
   - **description** (optional): One-line summary of the directory listing task.
   - **sequential** (optional): If the listing result is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```` ``` ````).

```json
{
  "action": "list_folders",
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
      "value": "List folders in the given directory"
    }
  ]
}
```

### Field Rules

| Field           | Type    | Required | Notes                                                                                |
|-----------------|---------|----------|--------------------------------------------------------------------------------------|
| `action`        | string  | Yes      | Must be exactly `"list_folders"`.                                                      |
| `directoryPath` | string  | Yes      | Directory to list. Default `"./"`.                                                   |
| `recursive`     | boolean | No       | List folders in subdirectories. Default `false`.                                       |
| `includeHidden` | boolean | No       | Include folders whose names start with `.`. Default `false`.                            |
| `includeGlob`   | string  | No       | Glob pattern to include. Default `"*"`.                                              |
| `excludeGlob`   | string  | No       | Comma-separated globs to exclude. Default `""` (no exclusion).                      |
| `showDetails`   | boolean | No       | Show folder size and modification time. Default `false`.                               |
| `maxResults`    | string  | No       | Integer as string. Default `"500"`.                                                  |
| `description`   | string  | No       | Human-readable purpose of the listing.                                               |
| `sequential`    | object  | No       | Whether the listing result should feed a follow-up AI task. Default null.            |
| `prompt`        | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented.                                |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `folder-list` payloads in a single response.
- If the user does not specify a directory, default to `./`.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "list_folders",
>   "thinking": "User asked to list folders in the current directory.",
>   "properties": [
>     { "name": "directoryPath", "value": "./" },
>     { "name": "recursive", "value": "false" },
>     { "name": "includeHidden", "value": "false" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": "" },
>     { "name": "showDetails", "value": "false" },
>     { "name": "maxResults", "value": "500" },
>     { "name": "description", "value": "List current directory folders" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply listing/enumerating folders (subdirectories) in a directory?
    |     |
    |     +-- YES --> Extract dir path/flags --> Emit ONE `folder-list` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple listing in current directory
**User:** "List all folders in the current directory."

**LLM emits:**
```json
{
  "action": "list_folders",
  "thinking": "User wants a simple flat listing of folders in the current directory.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "false" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List folders in ./" }
  ]
}
```

### Example 2: Recursive listing with glob filter
**User:** "Show me all folders named `src*` under the project recursively."

**LLM emits:**
```json
{
  "action": "list_folders",
  "thinking": "User wants all folders matching src* recursively.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
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

### Example 3: Listing with details
**User:** "Show me all folders in the project root with their sizes and modification times."

**LLM emits:**
```json
{
  "action": "list_folders",
  "thinking": "User wants folder details (size, time) for root directory.",
  "properties": [
    { "name": "directoryPath", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "includeHidden", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": "" },
    { "name": "showDetails", "value": "true" },
    { "name": "maxResults", "value": "500" },
    { "name": "description", "value": "List folders with details" }
  ]
}
```

## Safety Guidelines

1. Never list folders outside the user's intent (no arbitrary system paths).
2. Refuse suspicious paths (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Cap the number of folders returned via `maxResults` to avoid enormous output.
4. Do not recurse into blocked directories.
5. Always echo the JSON payload so the user can review before execution.
