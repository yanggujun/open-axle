# 📁 File Finder Skill

## Overview

This skill enables the LLM to help users **find files by name** in a specified directory by producing a **strictly-formatted JSON output** that describes the search. The JSON output is then parsed by the `file_finder_execute` skill to walk the filesystem, match filenames against a pattern, and return the list of matching file paths.

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`file-finder`

## When to Use This Skill

Invoke this skill whenever the user's request implies finding/searching for files by name. Look for phrases such as:

- "find files named ..."
- "search for files with name ..."
- "list files matching ..."
- "where is the file ..."
- "locate ... file"
- "which files are called ..."

Do **NOT** use this skill when the user wants to:
- Search inside file contents → use `file-grep`.
- Create a file → use `file-creator`.
- Modify a file → use `file-changer`.
- Read a file → use `file-reader`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **pattern** (required): The filename or glob pattern to search for.
   - **path** (optional): The directory to search in. Defaults to `./` (current working directory).
   - **recursive** (optional): `true` to search subdirectories. Defaults to `true`.
   - **isRegex** (optional): `true` to interpret `pattern` as a Python regular expression. Defaults to `false` (glob matching).
   - **caseSensitive** (optional): `true` for case-sensitive matching. Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to restrict which files are considered (e.g. `*.py`). Defaults to `*`.
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to common noise directories like `.git,node_modules,__pycache__,.venv,dist,build`.
   - **maxResults** (optional): Maximum number of matching files to return. Defaults to `100`.
   - **showPaths** (optional): `true` to include full paths in the output. Defaults to `true`.
   - **sequential** (optional): presented if the find result is needed as input for a follow-up AI task.
   - **prompt** (optional): When `sequential` is presented, this prompt is used to ask the AI to perform all of the follow-up tasks on the find result.
   - **description** (optional): One-line summary of the search.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```
{
  "action": "find_file",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "The files are provided below.<for followup tasks>"
  },
  "properties": [
    { "name": "pattern",       "value": "<filename-or-glob>" },
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
| `action`        | string  | Yes      | Must be exactly `"find_file"`.                                                 |
| `pattern`       | string  | Yes      | The filename pattern (glob or regex when `isRegex=true`). Must be non-empty.   |
| `path`          | string  | No       | Directory to search. Defaults to `./`.                                         |
| `recursive`     | boolean | No       | Default `true`.                                                                |
| `isRegex`       | boolean | No       | Default `false`.                                                               |
| `caseSensitive` | boolean | No       | Default `false`.                                                               |
| `includeGlob`   | string  | No       | Glob filter for filenames. Default `*`.                                        |
| `excludeGlob`   | string  | No       | Comma-separated globs to skip. Default excludes common noise dirs.             |
| `maxResults`    | string  | No       | Integer as string. Default `100`.                                              |
| `showPaths`     | boolean | No       | Include full paths in output. Default `true`.                                  |
| `sequential`    | object  | No       | Whether the find result should feed a follow-up AI task. Default null.         |
| `prompt`        | string  | No       | Follow-up prompt for all of the following tasks when `sequential` is presented.                          |
| `description`   | string  | No       | Human-readable purpose of the search.                                          |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `file-finder` payloads in a single response.
- If the user does not specify a pattern, do NOT execute this skill — ask for the pattern first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "find_file",
>   "thinking": "User wants to find all Python files in the current directory.",
>   "properties": [
>     { "name": "pattern", "value": "*.py" },
>     { "name": "path", "value": "./" },
>     { "name": "recursive", "value": "true" },
>     { "name": "isRegex", "value": "false" },
>     { "name": "caseSensitive", "value": "false" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
>     { "name": "maxResults", "value": "100" },
>     { "name": "showPaths", "value": "true" },
>     { "name": "description", "value": "Find all Python files" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply finding files by name?
    |     |
    |     +-- YES --> Extract pattern/path/flags --> Emit ONE `file-finder` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple glob search in current directory
**User:** "Find all `.py` files here."

**LLM emits:**
```
{
  "action": "find_file",
  "thinking": "User wants to find all Python files in the current directory recursively.",
  "properties": [
    { "name": "pattern", "value": "*.py" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Find Python files" }
  ]
}
```

### Example 2: Case-sensitive exact name search
**User:** "Find the file exactly named `config.json` in the project root."

**LLM emits:**
```
{
  "action": "find_file",
  "thinking": "Case-sensitive exact filename search for config.json in root.",
  "properties": [
    { "name": "pattern", "value": "config.json" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "false" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "true" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "10" },
    { "name": "showPaths", "value": "true" },
    { "name": "description", "value": "Locate config.json" }
  ]
}
```

### Example 3: Regex search in a specific folder
**User:** "In `src/`, find files matching the regex `test_.*\.py$`."

**LLM emits:**
```
{
  "action": "find_file",
  "thinking": "Regex filename search in src/ for test files.",
  "properties": [
    { "name": "pattern", "value": "test_.*\.py$" },
    { "name": "path", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "true" },
    { "name": "caseSensitive", "value": "false" },
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
3. Cap the number of files returned via `maxResults` to avoid runaway output.
4. Skip unreadable directories silently — do not crash.
5. Always echo the JSON payload so the user can review before execution.
