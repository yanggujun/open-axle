# 📖 File Reader Skill

## Overview

This skill enables the LLM to read files from disk by understanding the user's intent and producing a **strictly-formatted JSON output** that describes what file to read. The JSON output can then be parsed by the `file_reader_execute` skill to actually read the file from disk.

## Skill Name

`file-reader`

## When to Use This Skill

Invoke this skill whenever the user's request implies reading, viewing, opening, loading, inspecting, or examining a file. Look for phrases such as:

- "read the file ..."
- "open ..."
- "show me the content of ..."
- "view ..."
- "load ..."
- "what's inside ..."
- "print/display the contents of ..."
- "look at ..."
- "check ..."
- "inspect ..."

The skill also applies whenever the AI itself needs the content of a file to accomplish a task the user asked for (e.g., "summarize `notes.txt`", "fix the bug in `main.py`", "translate `hello.md`"). In such cases, the AI should first emit a `file-reader` JSON payload to fetch the file's content.

The skill applies to any file type: source code (`.py`, `.js`, `.java`, `.ts`, `.go`, `.c`, `.cpp`, ...), config (`.json`, `.yaml`, `.toml`, `.ini`, `.env`), markup (`.md`, `.html`, `.xml`), plain text (`.txt`, `.log`), and more.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **action** (required): must be `read_file`
   - **file_path** (required): The path to the file to read (relative or absolute). If the user does not specify a directory, default to the current working directory `./`.
   - **filename** (required): The file name including extension. Can be embedded inside `file_path`.
   - **encoding** (optional): Defaults to `utf-8` if not specified.
   - **max_bytes** (optional): Maximum number of bytes to read. `0` or omitted means read the entire file.
   - **start_line** (optional): 1-based line to start reading from. Defaults to `1`.
   - **end_line** (optional): 1-based inclusive last line to read. `0` or omitted means read to end of file.
   - **description** (optional): One-line summary of why the file is being read.
   - **sequential** (optional): when it is presented, it indicates the LLM needs the file content as an input to do further tasks.
   - **prompt** (optional): when sequential is presented, the prompt is used to ask AI to do follow up tasks. When there are multiple files to read, the next prompt should contains all the files and specify which file should be read in the next prompt. The prompt should contain all of following tasks.

2. **Produce a response containing pure JSON** that STRICTLY follows the schema below. No other JSON blocks in the reply.

## Required JSON Output Schema

The LLM's response MUST contain exactly pure JSON format string with no code blocks starting with "```".

````JSON
{
  "action": "read_file",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "<the prompt required for the conversation to continue>"
  }
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
      "name": "maxBytes",
      "value": "0"
    },
    {
      "name": "startLine",
      "value": "1"
    },
    {
      "name": "endLine",
      "value": "0"
    }
  ]
}
````

### Field Rules

| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | Must be exactly `"read_file"`.                                        |
| `sequential`  | object | No       | if the file content is needed to be input for ai for further tasks.     |
| `prompt`      | string | No       | the prompt used as input for LLM for all of following tasks.     |
| `filePath`    | string  | Yes      | Directory portion OR full path. Use `"./"` if unspecified.            |
| `fileName`    | string  | Yes      | Filename including extension. Omit if `filePath` already includes it. |
| `encoding`    | string  | No       | Default `utf-8`.                                                      |
| `maxBytes`    | string  | No       | Numeric string. `"0"` = unlimited. Default `"0"`.                     |
| `startLine`   | string  | No       | 1-based line. Default `"1"`.                                          |
| `endLine`     | string  | No       | 1-based inclusive line. `"0"` = end of file. Default `"0"`.           |
| `description` | string  | No       | Human-readable reason for reading.                                    |

### Formatting Requirements

- The JSON block **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** wrap the JSON in additional Markdown fences.
- Do **NOT** emit multiple `file-reader` blocks in a single response.

## Response Pattern for the LLM

A typical assistant reply should look like the following, with no other output. The response should be in pure JSON format.

> {
>   "action": "read_file",
>   "thinking": "User asked to view README.md; using default encoding utf-8 and reading whole file.",
>   "properties": [
>     { "name": "filePath", "value": "./" },
>     { "name": "fileName", "value": "README.md" },
>     { "name": "encoding", "value": "utf-8" },
>     { "name": "maxBytes", "value": "0" },
>     { "name": "startLine", "value": "1" },
>     { "name": "endLine", "value": "0" },
>     { "name": "description", "value": "Show the project README" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply reading/viewing/loading an existing file,
    |   OR does the AI need the file's content to answer the request?
    |     |
    |     +-- YES --> Extract path/name --> Emit ONE `file-reader` JSON block
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Explicit path
**User:** "Read the file `config/app.json`." and analyze the content

**LLM emits:**
``` JSON
{
  "action": "read_file",
  "thinking": "User explicitly asked to read config/app.json.",
  "sequential": {
    "prompt": "The file content is provided below, please analyze the content:"
  },
  "properties": [
    { "name": "filePath", "value": "config/" },
    { "name": "fileName", "value": "app.json" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "maxBytes", "value": "0" },
    { "name": "startLine", "value": "1" },
    { "name": "endLine", "value": "0" },
    { "name": "description", "value": "Read application configuration" }
  ]
}
```

### Example 2: Implicit read to accomplish a task
**User:** "Summarize what's in `notes.txt`."

**LLM emits:**
``` JSON
{
  "action": "read_file",
  "thinking": "To summarize notes.txt I first need its content; emit a read_file payload.",
  "sequential": {
    "prompt": "Following is the file content. <note: no need to put the content here>"
  },
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "notes.txt" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "maxBytes", "value": "0" },
    { "name": "startLine", "value": "1" },
    { "name": "endLine", "value": "0" },
    { "name": "description", "value": "Load notes.txt for summarization" }
  ]
}
```

### Example 3: Partial read (line range)
**User:** "Show me lines 10 to 40 of `main.py`."

**LLM emits:**
``` JSON
{
  "action": "read_file",
  "thinking": "User wants a specific line range from main.py.",
  "properties": [
    { "name": "filePath", "value": "./" },
    { "name": "fileName", "value": "main.py" },
    { "name": "encoding", "value": "utf-8" },
    { "name": "maxBytes", "value": "0" },
    { "name": "startLine", "value": "10" },
    { "name": "endLine", "value": "40" },
    { "name": "description", "value": "Show lines 10-40 of main.py" }
  ]
}
```
