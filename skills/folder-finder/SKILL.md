# 📁 Folder Finder Skill

## Overview

This skill enables the LLM to help users **find folders by name** in a specified directory by producing a **strictly-formatted JSON output** that describes the search. The JSON output is then parsed by the `folder_finder_execute` skill to walk the filesystem, match folder names against a pattern, and return the list of matching folder paths.

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`folder-finder`

## When to Use This Skill

Invoke this skill whenever the user's request implies finding/searching for folders by name. Look for phrases such as:

- "find folders named ..."
- "search for directories with name ..."
- "list folders matching ..."
- "where is the folder ..."
- "locate ... directory"
- "which folders are called ..."

Do **NOT** use this skill when the user wants to:
- Search inside file contents → use `file-grep`.
- Create a folder → use `folder-creator`.
- Modify a folder → (no direct skill).
- Read a file → use `file-reader`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **pattern** (required): The folder name or glob pattern to search for.
   - **path** (optional): The directory to search in. Defaults to `./` (current working directory).
   - **recursive** (optional): `true` to search subdirectories. Defaults to `true`.
   - **isRegex** (optional): `true` to interpret `pattern` as a regular expression. Defaults to `false` (glob matching).
   - **caseSensitive** (optional): `true` for case-sensitive matching. Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to restrict which folders are considered (e.g. `src*`). Defaults to `*`.
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to common noise directories like `.git,node_modules,__pycache__,.venv,dist,build`.
   - **maxResults** (optional): Maximum number of matching folders to return. Defaults to `100`.
   - **showPaths** (optional): `true` to include full paths in the output. Defaults to `true`.
   - **sequential** (optional): presented if the find result is needed as input for a follow-up AI task.
   - **prompt** (optional): When `sequential` is presented, this prompt is used to ask the AI to perform all of follow-up tasks on the find result.
   - **description** (optional): One-line summary of the search.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```
{
  "action": "find_folder",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    { "name": "pattern",       "value": "<folder-name-or-glob>" },
    { "name": "path",          "value": "./" },
    { "name": "recursive",     "value": "true" },
    { "name": "isRegex",       "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob",   "value": "*" },
    { "name": "excludeGlob",   "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults",    "value": "100" },
    { "name": "showPaths",     "value": "true" }
  ]
}
```

### Field Rules

| Field           | Type    | Required | Notes                                                                          |
|-----------------|---------|----------|--------------------------------------------------------------------------------|
| `action`        | string  | Yes      | Must be exactly `"find_folder"`.                                               |
| `pattern`       | string  | Yes      | The folder name pattern (glob or regex when `isRegex=true`). Must be non-empty.|
| `path`          | string  | No       | Directory to search. Defaults to `./`.                                         |
| `recursive`     | boolean | No       | Default `true`.                                                                |
| `isRegex`       | boolean | No       | Default `false`.                                                               |
| `caseSensitive` | boolean | No       | Default `false`.                                                               |
| `includeGlob`   | string  | No       | Glob filter for folder names. Default `*`.                                     |
| `excludeGlob`   | string  | No       | Comma-separated globs to skip. Default excludes common noise dirs.             |
| `maxResults`    | string  | No       | Integer as string. Default `100`.                                              |
| `showPaths`     | boolean | No       | Include full paths in output. Default `true`.                                  |
| `sequential`    | object  | No       | Whether the find result should feed a follow-up AI task. Default null.         |
| `prompt`        | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented.                          |
| `description`   | string  | No       | Human-readable purpose of the search.                                          |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `folder-finder` payloads in a single response.
- If the user does not specify a pattern, do NOT execute this skill — ask for the pattern first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "find_folder",
>   "thinking": "User wants to find all folders containing 'test' in the project.",
>   "properties": [
>     { "name": "pattern", "value": "*test*" },
>     { "name": "path", "value": "./" },
>     { "name": "recursive", "value": "true" },
>     { "name": "isRegex", "value": "false" },
>     { "name": "caseSensitive", "value": "false" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
>     { "name": "maxResults", "value": "100" },
>     { "name": "showPaths", "value": "true" },
>     { "name": "description", "value": "Find test folders" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply finding folder/directories by name?
    |     |
    |     +-- YES --> Extract pattern/path/flags --> Emit ONE `folder-finder` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple glob search in current directory
**User:** "Find all folders named `src`."

**LLM emits:**
```
{
  "action": "find_folder",
  "thinking": "User wants to find all folders named src in the current directory recursively.",
  "properties": [
    { "name": "pattern", "value": "src" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find src folders" }
  ]
}
```

### Example 2: Case-sensitive exact name search
**User:** "Find the folder exactly named `config` in the project root."

**LLM emits:**
```
{
  "action": "find_folder",
  "thinking": "Case-sensitive exact folder name search for config in root.",
  "properties": [
    { "name": "pattern", "value": "config" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "true" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "10" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Locate config folder" }
  ]
}
```

### Example 3: Regex search in a specific folder
**User:** "In `src/`, find folders matching the regex `^test_.*`."

**LLM emits:**
```
{
  "action": "find_folder",
  "thinking": "Regex folder name search in src/ for test folders.",
  "properties": [
    { "name": "pattern", "value": "^test_.*" },
    { "name": "path", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "true" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find test folders in src/" }
  ]
}
```

## Safety Guidelines

1. Never search paths outside the user's intent (no arbitrary system paths).
2. Refuse suspicious search roots (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Cap the number of folders returned via `maxResults` to avoid runaway output.
4. Skip unreadable directories silently — do not crash.
5. Always echo the JSON payload so the user can review before execution.
