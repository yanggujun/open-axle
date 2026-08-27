# 🔎 File Grep Skill

## Overview

This skill enables the LLM to help users **search for a text pattern inside files** (basic `grep`-like functionality) by producing a **strictly-formatted JSON output** that describes the search. The JSON output is then parsed by the `file_grep_execute` skill to walk the filesystem, match the pattern, and return the list of matching **file locations** (and optionally the matching lines).

The default working directory is the **current directory** (`./`) unless the user specifies otherwise.

## Skill Name

`file-grep`

## When to Use This Skill

Invoke this skill whenever the user's request implies searching text inside files. Look for phrases such as:

- "grep for ..."
- "search for ... in files"
- "find files containing ..."
- "which files have ..."
- "look up ... in the codebase"
- "where is the string ... used"
- "list files with the word ..."

Do **NOT** use this skill when the user wants to:
- Create a file → use `file-creator`.
- Modify a file → use `file-changer`.
- Read the entire content of one specific file → use `file-reader`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **pattern** (required): The string or regex to search for.
   - **path** (optional): The directory or file to search in. Defaults to `./` (current working directory).
   - **recursive** (optional): `true` to search subdirectories. Defaults to `true`.
   - **isRegex** (optional): `true` to interpret `pattern` as a Python regular expression. Defaults to `false` (plain substring search).
   - **caseSensitive** (optional): `true` for case-sensitive matching. Defaults to `false`.
   - **includeGlob** (optional): A glob pattern to restrict which files are searched (e.g. `*.py`, `*.md`). Defaults to `*` (all files).
   - **excludeGlob** (optional): Glob pattern(s) to skip (comma-separated). Defaults to common noise directories like `.git,node_modules,__pycache__,.venv,dist,build`.
   - **maxResults** (optional): Maximum number of matching files to return. Defaults to `100`.
   - **showLines** (optional): `true` to include matching lines with line numbers in the output. Defaults to `true`.
   - **sequential** (optional): presented if the grep result is needed as input for a follow-up AI task. Mirrors the file-reader `sequential` object.
   - **prompt** (optional): When `sequential` is presented, this prompt is used to ask the AI to perform all of follow-up tasks on the grep result.
   - **description** (optional): One-line summary of the search.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```` ``` ````).

``` JSON
{
  "action": "grep_file",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    { "name": "pattern",       "value": "<text-or-regex>" },
    { "name": "path",          "value": "./" },
    { "name": "recursive",     "value": "true" },
    { "name": "isRegex",       "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob",   "value": "*" },
    { "name": "excludeGlob",   "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults",    "value": "100" },
    { "name": "showLines",     "value": "true" },
  ]
}
```

### Field Rules

| Field           | Type    | Required | Notes                                                                          |
|-----------------|---------|----------|--------------------------------------------------------------------------------|
| `action`        | string  | Yes      | Must be exactly `"grep_file"`.                                                 |
| `pattern`       | string  | Yes      | The search string (or regex when `isRegex=true`). Must be non-empty.           |
| `path`          | string  | No       | Directory or file to search. Defaults to `./`.                                 |
| `recursive`     | boolean | No       | Default `true`.                                                                |
| `isRegex`       | boolean | No       | Default `false`.                                                               |
| `caseSensitive` | boolean | No       | Default `false`.                                                               |
| `includeGlob`   | string  | No       | Glob filter for filenames. Default `*`.                                        |
| `excludeGlob`   | string  | No       | Comma-separated globs to skip. Default excludes common noise dirs.             |
| `maxResults`    | string  | No       | Integer as string. Default `100`.                                              |
| `showLines`     | boolean | No       | Include matching line numbers and text. Default `true`.                        |
| `sequential`    | object | No       | Whether the grep result should feed a follow-up AI task. Default null.      |
| `prompt`        | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented |
| `description`   | string  | No       | Human-readable purpose of the search.                                          |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `file-grep` payloads in a single response.
- If the user does not specify a pattern to search, do NOT execute this skill — ask for the pattern first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "grep_file",
>   "thinking": "User wants to find files that contain the word TODO in the current directory.",
>   "properties": [
>     { "name": "pattern", "value": "TODO" },
>     { "name": "path", "value": "./" },
>     { "name": "recursive", "value": "true" },
>     { "name": "isRegex", "value": "false" },
>     { "name": "caseSensitive", "value": "false" },
>     { "name": "includeGlob", "value": "*" },
>     { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
>     { "name": "maxResults", "value": "100" },
>     { "name": "showLines", "value": "true" },
>     { "name": "description", "value": "Search TODO markers in the project" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply searching text inside files?
    |     |
    |     +-- YES --> Extract pattern/path/flags --> Emit ONE `file-grep` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple substring search in current directory
**User:** "Find all files containing `def main` here."

**LLM emits:**
{
  "action": "grep_file",
  "thinking": "User wants a plain substring search for 'def main' in the current directory, recursively.",
  "properties": [
    { "name": "pattern", "value": "def main" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showLines", "value": "true" },
    { "name": "description", "value": "Locate main function definitions" }
  ]
}

### Example 2: Case-sensitive search restricted to Python files
**User:** "Which `.py` files contain the class `MyClass`? Be case sensitive."

**LLM emits:**
{
  "action": "grep_file",
  "thinking": "User asked case-sensitive search restricted to .py files.",
  "properties": [
    { "name": "pattern", "value": "MyClass" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "true" },
    { "name": "includeGlob", "value": "*.py" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showLines", "value": "true" },
    { "name": "description", "value": "Find Python files defining MyClass" }
  ]
}

### Example 3: Regex search in a specific folder
**User:** "In `src/`, find files matching the regex `TODO\\(.*\\)`."

**LLM emits:** 
{
  "action": "grep_file",
  "thinking": "Regex search restricted to src/ folder.",
  "properties": [
    { "name": "pattern", "value": "TODO\\(.*\\)" },
    { "name": "path", "value": "src/" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "true" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showLines", "value": "true" },
    { "name": "description", "value": "Regex TODO scan in src/" }
  ]
}

### Example 4: File-name-only output
**User:** "Just list the files that contain the word `password`, don't show lines."

**LLM emits:**(no code fence)
```JSON
{
  "action": "grep_file",
  "thinking": "User only wants file paths, not the matched lines.",
  "properties": [
    { "name": "pattern", "value": "password" },
    { "name": "path", "value": "./" },
    { "name": "recursive", "value": "true" },
    { "name": "isRegex", "value": "false" },
    { "name": "caseSensitive", "value": "false" },
    { "name": "includeGlob", "value": "*" },
    { "name": "excludeGlob", "value": ".git,node_modules,__pycache__,.venv,dist,build" },
    { "name": "maxResults", "value": "100" },
    { "name": "showLines", "value": "false" },
    { "name": "description", "value": "List files containing 'password'" }
  ]
}
```

## Safety Guidelines

1. Never search paths outside the user's intent (no arbitrary system paths).
2. Refuse suspicious search roots (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. Cap the number of files returned via `maxResults` to avoid runaway output.
4. Skip binary files and unreadable files silently — do not crash.
5. Always echo the JSON payload so the user can review before execution.