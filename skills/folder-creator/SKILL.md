# 📁 Folder Creator Skill

## Overview

This skill enables the LLM to help users **create folders** (directories) on disk by understanding their intent and producing a **strictly-formatted JSON output** that describes which folder to create. The JSON output is then parsed by the `folder_creator_execute` skill to actually create the folder.

## Skill Name

`folder-creator`

## When to Use This Skill

Invoke this skill whenever the user's request implies creating a new folder/directory. Look for phrases such as:

- "create a folder named ..."
- "make a directory called ..."
- "mkdir ..."
- "create a directory at ..."
- "new folder ..."
- "set up a folder structure ..."

Do **NOT** use this skill when the user wants to:
- Create a file → use `file-creator`.
- If the folder already exists, **NEVER** overwrite the existing one.
- Create a nested structure of both files and folders → you may use multiple skills sequentially.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **folderPath** (required): The path (directory portion) where the folder should be created. If the user does not specify a parent directory, default to the current working directory `./`.
   - **folderName** (required): The name of the new folder. May be omitted if `folderPath` includes the full desired path.
   - **recursive** (optional): `true` to create all intermediate directories (like `mkdir -p`). Defaults to `true`.
   - **description** (optional): One-line summary of the folder creation.
   - **sequential** (optional): Presented if the folder creation is part of a larger multi-step task.
   - **prompt** (optional): Follow-up prompt for all of following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks (no leading ```` ``` ````).

``` JSON
{
  "action": "create_folder",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    { "name": "folderPath", "value": "./" },
    { "name": "folderName", "value": "new-folder" },
    { "name": "recursive", "value": "true" },
    { "name": "description", "value": "Create a new folder" }
  ]
}
```

### Field Rules

| Field        | Type    | Required | Notes                                                                       |
|--------------|---------|----------|-----------------------------------------------------------------------------|
| `action`     | string  | Yes      | Must be exactly `"create_folder"`.                                          |
| `folderPath` | string  | Yes      | Parent directory path. Default `"./"`.                                      |
| `folderName` | string  | Yes*     | Folder name. Omit if `folderPath` includes the full path.                   |
| `recursive`  | boolean | No       | `true` to create intermediate directories. Default `true`.                  |
| `description`| string  | No       | Human-readable purpose.                                                     |
| `sequential` | object  | No       | Whether the result should feed a follow-up AI task. Default null.           |
| `prompt`     | string  | No       | Follow-up prompt for all of following tasks when `sequential` is presented.                       |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `folder-creator` payloads in a single response.
- If the user does not specify a folder name or path, do NOT execute this skill — ask for the name first or produce an empty action.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "create_folder",
>   "thinking": "User asked to create a 'data' folder in the current directory.",
>   "properties": [
>     { "name": "folderPath", "value": "./" },
>     { "name": "folderName", "value": "data" },
>     { "name": "recursive", "value": "true" },
>     { "name": "description", "value": "Create data folder" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply creating a folder/directory?
    |     |
    |     +-- YES --> Extract folder path/name/flags --> Emit ONE `folder-creator` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple folder in current directory
**User:** "Create a folder named `images` here."

**LLM emits:**
{
  "action": "create_folder",
  "thinking": "User wants a simple 'images' folder in cwd.",
  "properties": [
    { "name": "folderPath", "value": "./" },
    { "name": "folderName", "value": "images" },
    { "name": "recursive", "value": "true" },
    { "name": "description", "value": "Create images folder" }
  ]
}

### Example 2: Nested folders with recursive
**User:** "Create the path `projects/my-app/src` — make sure all parent folders are created."

**LLM emits:**
{
  "action": "create_folder",
  "thinking": "User wants a full path created with all intermediate directories.",
  "properties": [
    { "name": "folderPath", "value": "projects/my-app/" },
    { "name": "folderName", "value": "src" },
    { "name": "recursive", "value": "true" },
    { "name": "description", "value": "Create nested folder structure" }
  ]
}

### Example 3: Explicit full path
**User:** "Make `/home/user/temp/output` — create if needed."

**LLM emits:**
{
  "action": "create_folder",
  "thinking": "User provided a full absolute path to create; recursive must be true.",
  "properties": [
    { "name": "folderPath", "value": "/home/user/temp/" },
    { "name": "folderName", "value": "output" },
    { "name": "recursive", "value": "true" },
    { "name": "description", "value": "Create output directory" }
  ]
}

## Safety Guidelines

1. Never create folders outside the user's intent (no arbitrary system paths).
2. Refuse suspicious paths (e.g., `C:\Windows\`, `/etc/`, `~/.ssh/`).
3. When `recursive: true`, ensure the operation does not accidentally create many directories outside the user's project.
5. Always echo the JSON payload so the user can review before execution.
