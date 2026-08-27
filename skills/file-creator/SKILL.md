# 📄 File Creator Skill

## Overview

This skill enables the LLM to help users create files by understanding their intent and producing a **strictly-formatted JSON output** that describes what file to create. 

If the file is too large, the content can be separated into two or more parts, first to use file-creator to create the file and first part of the content, then the following parts can be output by file-changer skills to append.

## Skill Name

`file-creator`

## When to Use This Skill

Invoke this skill whenever the user's request implies creating a new file. Look for phrases such as:

- "create a file ..."
- "make a new file ..."
- "generate a ... file"
- "write a ... file"
- "save this as a file"
- "new script/document/config/readme ..."
- "produce a JSON/YAML/HTML/Python/Markdown file"

The skill applies to any file type: source code (`.py`, `.js`, `.java`, `.ts`, `.go`, `.c`, `.cpp`, ...), config (`.json`, `.yaml`, `.toml`, `.ini`, `.env`), markup (`.md`, `.html`, `.xml`), plain text (`.txt`, `.log`), and more.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **file_path** (required): The target path where the file should be created (relative or absolute). If the user does not specify a directory, default to the current working directory `./`.
   - **filename** (required): The final file name including extension. Infer a sensible name/extension from the description if omitted (e.g. "python hello world" → `hello.py`).
   - **content** (required): The complete content of the file.
   - **language / file_type** (optional): The language or format label (e.g. `python`, `json`, `markdown`, `text`).
   - **overwrite** (optional): `true` if the user explicitly asks to replace/overwrite an existing file, otherwise `false`.
   - **encoding** (optional): Defaults to `utf-8` if not specified.
   - **description** (optional): One-line summary of the file's purpose.
   - **sequential** (optional): if the file creation is just one part of LLM decision flows, it is presented for next task.
   - **prompt** (optional): when sequential is presented, the prompt is used for next input to LLM for next task.

2. **Produce a response containing a single fenced JSON code block** that STRICTLY follows the schema below. No other JSON blocks in the reply.

## Required JSON Output Schema

The LLM's response MUST contain exactly pure JSON format string with no code blocks start with "```". When there is no content specified by the user, just directly create an empty file.

```` JSON
{
  "action": "create_file",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "prompt used for next task"
  },
  "properties": [
    {
      "name": "filePath",
      "value": "<directory-or-full-path>"
    },
    {
      "name": "fileName",
      "value": "<name-with-extension>"
    },
    {
      "name": "encoding",
      "value": "utf-8"
    },
    {
      "name": "encoding",
      "value": "utf-8"
    },
    {
      "name": "overwrite",
      "value": "false"
    },
    {
      "name": "content",
      "value": ""
    }
  ]
}
````

### Field Rules

| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | Must be exactly `"create_file"`.                                      |
| `file_path`   | string  | Yes      | Directory portion OR full path. Use `"./"` if unspecified.            |
| `filename`    | string  | Yes      | Filename including extension. Omit if `file_path` already includes it.|
| `language`    | string  | No       | e.g. `python`, `json`, `markdown`, `yaml`, `text`.                    |
| `encoding`    | string  | No       | Default `utf-8`.                                                      |
| `overwrite`   | boolean | No       | `true` to overwrite; default `false`.                                 |
| `description` | string  | No       | Human-readable purpose of the file.                                   |
| `content`     | string  | Yes      | Full file contents as a JSON string. Need to populate escaped contents as it is in a JSON string. Escape newlines as `\n`.         |
| `sequential`    | object | No       | Whether the grep result should feed a follow-up AI task. Default null.      |
| `prompt`        | string  | No       | Follow-up prompt used when `sequential` is presented |

### Formatting Requirements

- The JSON block **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** wrap `content` in additional Markdown fences — it is a plain string.
- Do **NOT** emit multiple `file-creator` blocks in a single response.

## Response Pattern for the LLM
A typical assistant reply should look like, no other output is needed. 
The response should be in pure json format and if the user do not specify the content, no need to prompt for file content. 
Overwrite property should be set to true only WHEN user requests to do so EXPLICITLY. 
If the user or LLM decision result does not specify a file name, the skill should not be executed.
The file content should escape any known text format, like html, xml, json. The string should be in escaped mode.

> {
>   "action": "create_file",
>   "thinking": "User asked for a simple hello-world Python program; inferring filename hello.py in current directory.",
>   "properties": [
>     { "name": "filePath", "value": "./" },
>     { "name": "fileName", "value": "hello.py" },
>     { "name": "language", "value": "python" },
>     { "name": "encoding", "value": "utf-8" },
>     { "name": "overwrite", "value": "false" },
>     { "name": "description", "value": "A simple hello-world Python program" },
>     { "name": "content", "value": "def main():\n    print(\"Hello, world!\")\n\nif __name__ == \"__main__\":\n    main()\n" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply creating/generating/saving a new file?
    |     |
    |     +-- YES --> Extract path/name/content --> Emit ONE `file-creator` JSON block
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Explicit path and content
**User:** "Create a file `config/app.json` containing `{"debug": true, "port": 8080}`."

**LLM emits:**
{
  "action": "create_file",
  "thinking": "User explicitly provided the path config/app.json and the JSON content to write.",
  "properties": [
    { "name": "filePath", "value": "config/" },
    { "name": "fileName", "value": "app.json" },
    { "name": "language", "value": "json" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "overwrite", "value": "false" },
    { "name": "description", "value": "Application configuration" },
    { "name": "content", "value": "{\n  \"debug\": true,\n  \"port\": 8080\n}\n" }
  ]
}

### Example 2: Inferred name
**User:** "Write me a README for my project that just says 'Hello World'."

**LLM emits:**
{
  "action": "create_file",
  "thinking": "User asked for a README with 'Hello World' content; inferring README.md in the current directory.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "README.md" },
    { "name": "language", "value": "markdown" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "overwrite", "value": "false" },
    { "name": "description", "value": "Project README" },
    { "name": "content", "value": "# Hello World\n" }
  ]
}

### Example 3: Overwrite
**User:** "Replace `notes.txt` with the text 'new notes'."

**LLM emits:**
{
  "action": "create_file",
  "thinking": "User explicitly asked to replace notes.txt, so overwrite must be true.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "notes.txt" },
    { "name": "language", "value": "text" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "overwrite", "value": "true" },
    { "name": "description", "value": "Replaces notes.txt with new content" },
    { "name": "content", "value": "new notes\n" }
  ]
}


## Safety Guidelines

1. Never create files outside the user's intent (no arbitrary system paths).
2. Refuse to overwrite unless explicitly requested.
3. Refuse suspicious paths (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
4. Always show the JSON block so the user can review before execution.