# 🔍 Finder Skill

## Overview

This skill enables the LLM to help users **find files AND folders by name** in a specified directory — the equivalent of the Linux bash `find` tool — by producing a **strictly-formatted JSON output** that describes the search. The JSON output is then parsed by the `finder` skill to walk the filesystem, match entry names against a pattern (files and/or folders), and return the list of matching entry paths.

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`finder`

## When to Use This Skill

Invoke this skill whenever the user's request implies finding/searching for files, folders, or both by name. Look for phrases such as:

- "find files/folders named ..."
- "search for files and directories with name ..."
- "list entries matching ..."
- "where is the file/folder ..."
- "locate ... file or directory"
- "which files or folders are called ..."

Do **NOT** use this skill when the user wants to:
- Search inside file contents → use `file-grep`.
- Create a file → use `file-creator`.
- Modify a file → use `file-changer`.
- Read a file → use `file-reader`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **pattern** (required): The entry name (file or folder), glob pattern, or regex to search for.
   - **path** (optional): The directory to search in. Defaults to `./` (current working directory).
   - **recursive** (optional): `true` to search subdirectories. Defaults to `true`.
   - **isRegex** (optional): `true` to interpret `pattern` as a regular expression. Defaults to `false` (glob matching).
   - **caseSensitive** (optional): `true` for case-sensitive matching. Defaults to `false`.
   - **entryType** (optional): Filter for the type of entries to find: `file` (files only), `folder` (directories only), or `both` (files and folders, the default).
   - **includeGlob** (optional): A glob pattern to restrict which entries are considered (e.g. `*.py`). Defaults to `*`.
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to common noise directories like `.git,node_modules,__pycache__,.venv,dist,build`.
   - **maxResults** (optional): Maximum number of matching entries to return. Defaults to `100`.
   - **showPaths** (optional): `true` to include full paths in the output. Defaults to `true`.
   - **sequential** (optional): presented if the find result is needed as input for a follow-up AI task.
   - **prompt** (optional): When `sequential` is presented, this prompt is used to ask the AI to perform all of the follow-up tasks on the find result.
   - **description** (optional): One-line summary of the search.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```
{
  "action": "find_entry",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "<Follow-up prompt for all of following tasks>"
  },
  "properties": [
    { "name": "pattern",       "value": "<entry-name-or-glob>" },
    { "name": "path",          "value": "./" },
    { "name": "recursive",     "value": "true" },
    { "name": "isRegex",       "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "entryType",     "value": "both" },
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
| `action`        | string  | Yes      | Must be exactly `"find_entry"`.                                                |
| `pattern`       | string  | Yes      | The entry name pattern (glob or regex when `isRegex=true`). Must be non-empty. |
| `path`          | string  | No       | Directory to search. Defaults to `./`.                                         |
| `recursive`     | boolean | No       | Default `true`.                                                                |
| `isRegex`       | boolean | No       | Default `false`.                                                               |
| `caseSensitive` | boolean | No       | Default `false`.                                                               |
| `entryType`     | string  | No       | One of `file`, `folder`, or `both`. Default `both`.                            |
| `includeGlob`   | string  | No       | Glob filter for entry names. Default `*`.                                      |
| `excludeGlob`   | string  | No       | Comma-separated globs to skip. Default excludes common noise dirs.             |
| `maxResults`    | string  | No       | Integer as string. Default `100`.                                              |
| `showPaths`     | boolean | No       | Include full paths in output. Default `true`.                                  |
| `sequential`    | object  | No       | Whether the find result should feed a follow-up AI task. Default null.         |
| `prompt`        | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented.    |
| `description`   | string  | No       | Human-readable purpose of the search.                                          |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `finder` payloads in a single response.
- If the user does not specify a pattern, do NOT execute this skill — ask for the pattern first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "find_entry",
>   "thinking": "User wants to find all Python files and matching folders in the current directory.",
>   "properties": [
>     { "name": "pattern", "value": "*.py" },
>     { "name": "path", "value": "./" },
>     { "name": "recursive", "value": "true" },
>     { "name": "isRegex", "value": "false" },
>     { "name": "caseSensitive", "value": "false" },
>     { "name": "entryType", "value": "both" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
>     { "name": "maxResults", "value": "100" },
>     { "name": "showPaths", "value": "true" },
>     { "name": "description", "value": "Find entries matching pattern" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply finding entries (files and/or folders) by name?
    |     |
    |     +-- YES --> Extract pattern/path/entryType/flags --> Emit ONE `finder` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Search for both files and folders by glob (entryType=both)
**User:** "Find all entries named `config` here."

**LLM emits:**
```
{
  "action": "find_entry",
  "thinking": "User wants to find all files and folders named config in the current directory recursively.",
  "properties": [
    { "name": "pattern", "value": "config" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "entryType", "value": "both" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find all config-named entries (files and folders)" }
  ]
}
```

### Example 2: Only folders via entryType (regex search)
**User:** "In `src/`, find folders matching the regex `^test_.*`."

**LLM emits:**
```
{
  "action": "find_entry",
  "thinking": "Regex folder-name search in src/ restricted to directories via entryType=folder.",
  "properties": [
    { "name": "pattern", "value": "^test_.*" },
    { "name": "path", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "true" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "entryType", "value": "folder" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find test folders in src/" }
  ]
}
```

### Example 3: Only files via entryType (case-sensitive exact name, non-recursive)
**User:** "Find the file exactly named `config.json` in the project root."

**LLM emits:**
```
{
  "action": "find_entry",
  "thinking": "Case-sensitive exact filename search for config.json restricted to files via entryType=file, non-recursive.",
  "properties": [
    { "name": "pattern", "value": "config.json" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "true" },
    { "name": "entryType", "value": "file" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "10" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Locate config.json files" }
  ]
}
```

### Example 4: Regex file search with include globs
**User:** "In `src/`, find files matching the regex `test_.*\.py$`."

**LLM emits:**
```
{
  "action": "find_entry",
  "thinking": "Regex filename search in src/ for test files restricted to files via entryType=file.",
  "properties": [
    { "name": "pattern", "value": "test_.*\.py$" },
    { "name": "path", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "true" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "entryType", "value": "file" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find test files in src/" }
  ]
}
```

## Safety Guidelines

1. Never search paths outside the user's intent (no arbitrary system paths).
2. Refuse suspicious search roots (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Cap the number of entries returned via `maxResults` to avoid runaway output.
4. Skip unreadable directories silently — do not crash.
5. Always echo the JSON payload so the user can review before execution.
