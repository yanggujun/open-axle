# 🌐 Curl Skill

## Overview

This skill enables the LLM to perform HTTP requests (GET, POST, PUT, DELETE, etc.) by understanding the user's intent and producing a **strictly-formatted JSON output** that describes the request. The JSON output is then parsed by the `curl_execute` skill to actually make the HTTP request and return the response.

## Skill Name

`curl`

## When to Use This Skill

Invoke this skill whenever the user's request implies making an HTTP request. Look for phrases such as:

- "fetch URL ..."
- "make a GET request to ..."
- "POST to ..."
- "GET <some url>"
- "call the API at ..."
- "send a request to ..."
- "download from ..."
- "check the status of ..."
- "curl ..." (explicit)
- "HTTP GET/POST/PUT/DELETE ..."

Do **NOT** use this skill when the user wants to:
- Read a local file → use `file-reader`.
- Modify a local file → use `file-changer`.
- Create a file → use `file-creator`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **method** (required): HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). Defaults to GET if not specified.
   - **url** (required): The target URL. Must be a valid HTTP/HTTPS URL.
   - **headers** (optional): Dictionary of HTTP headers as key-value pairs.
   - **data** (optional): Body data for POST/PUT/PATCH requests. Can be a string, JSON object, or form-encoded data.
   - **dataType** (optional): Format of data (json, form, text). Defaults to text.
   - **timeout** (optional): Request timeout in seconds. Defaults to 30.
   - **followRedirects** (optional): Whether to follow redirects. Defaults to true.
   - **auth** (optional): Authentication (basic, bearer token, etc.).
   - **description** (optional): One-line summary of the request.
   - **sequential** (optional): If the response is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all of the following tasks when sequential is set.

2. **Produce a response containing pure JSON** that STRICTLY follows the schema below. No other JSON blocks in the reply.

## Required JSON Output Schema

```json
{
  "action": "curl",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "<the prompt for all of follow-up tasks>"
  },
  "properties": [
    { "name": "method", "value": "GET" },
    { "name": "url", "value": "https://example.com" },
    { "name": "headers", "value": "{}" },
    { "name": "data", "value": "" },
    { "name": "dataType", "value": "text" },
    { "name": "timeout", "value": "30" },
    { "name": "followRedirects", "value": "true" },
    { "name": "auth", "value": "" },
    { "name": "description", "value": "" }
  ]
}
```

### Field Rules

| Field            | Type   | Required | Notes                                                                 |
|------------------|--------|----------|-----------------------------------------------------------------------|
| `action`         | string | Yes      | Must be exactly `"curl"`.                                     |
| `method`         | string | Yes      | One of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS. Default GET.     |
| `url`            | string | Yes      | Valid HTTP/HTTPS URL. Must be non-empty.                              |
| `headers`        | string | No       | JSON-encoded dictionary of headers. Default `"{}"`.                  |
| `data`           | string | No       | Request body content.                                                 |
| `dataType`       | string | No       | `text`, `json`, or `form`. Default `text`.                            |
| `timeout`        | string | No       | Timeout in seconds as string. Default `"30"`.                        |
| `followRedirects`| string | No       | `"true"` or `"false"`. Default `"true"`.                            |
| `auth`           | string | No       | Authentication string (e.g., "Bearer token123").                     |
| `description`    | string | No       | Human-readable purpose.                                               |
| `sequential`     | object | No       | Whether the response should feed a follow-up AI task.                 |
| `prompt`         | string | No       | Follow-up prompt when sequential is present.                          |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- `headers` must be a valid JSON object string (e.g., `{"Content-Type": "application/json"}`).
- Do **NOT** emit multiple `curl` payloads in a single response.

## Response Pattern for the LLM

A typical assistant reply should look like the following, with no other output. The response should be in pure JSON format.

> {
>   "action": "curl",
>   "thinking": "User wants to GET example.com.",
>   "properties": [
>     { "name": "method", "value": "GET" },
>     { "name": "url", "value": "https://example.com" },
>     { "name": "headers", "value": "{}" },
>     { "name": "data", "value": "" },
>     { "name": "dataType", "value": "text" },
>     { "name": "timeout", "value": "30" },
>     { "name": "followRedirects", "value": "true" },
>     { "name": "auth", "value": "" },
>     { "name": "description", "value": "Fetch example.com homepage" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply making an HTTP request?
    |     |
    |     +-- YES --> Extract method/url/headers/data/flags --> Emit ONE `curl` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Authentication Configuration
The authentication configuration is defined in the local .axle configuration file.
```JSON
{
    "skill_configs": [
        {
            "skill": "curl",
            "config_items": [
                {
                    "name": "abc",
                    "value": {
                            "domain": "www.abc.com",
                            "auth_string": "bearer xxxx"
                    }
                },
                {
                    "name": "bcd",
                    "value": {
                        "domain": "www.bcd.com",
                        "auth_string": "bearer xxxxxxx"
                    }
                }
            ]
        }
    ]
}
```


## Examples

### Example 1: Simple GET request
**User:** "Fetch https://api.github.com/users/octocat"

**LLM emits:**
```json
{
  "action": "curl",
  "thinking": "User wants to make a GET request to the GitHub API.",
  "properties": [
    { "name": "method", "value": "GET" },
    { "name": "url", "value": "https://api.github.com/users/octocat" },
    { "name": "headers", "value": "{}" },
    { "name": "data", "value": "" },
    { "name": "dataType", "value": "text" },
    { "name": "timeout", "value": "30" },
    { "name": "followRedirects", "value": "true" },
    { "name": "auth", "value": "" },
    { "name": "description", "value": "Fetch GitHub user info" }
  ]
}
```

### Example 2: POST with JSON data
**User:** "POST to https://httpbin.org/post with JSON data: {"key": "value"}"

**LLM emits:**
```json
{
  "action": "curl",
  "thinking": "User wants to POST JSON data to httpbin.",
  "properties": [
    { "name": "method", "value": "POST" },
    { "name": "url", "value": "https://httpbin.org/post" },
    { "name": "headers", "value": "{\"Content-Type\": \"application/json\"}" },
    { "name": "data", "value": "{\"key\": \"value\"}" },
    { "name": "dataType", "value": "json" },
    { "name": "timeout", "value": "30" },
    { "name": "followRedirects", "value": "true" },
    { "name": "auth", "value": "" },
    { "name": "description", "value": "POST JSON payload" }
  ]
}
```

### Example 3: Request with custom headers
**User:** "Send a GET request to https://api.example.com with an Authorization header: Bearer mytoken"

**LLM emits:**
```json
{
  "action": "curl",
  "thinking": "User wants a GET request with a Bearer token.",
  "properties": [
    { "name": "method", "value": "GET" },
    { "name": "url", "value": "https://api.example.com" },
    { "name": "headers", "value": "{\"Authorization\": \"Bearer mytoken\"}" },
    { "name": "data", "value": "" },
    { "name": "dataType", "value": "text" },
    { "name": "timeout", "value": "30" },
    { "name": "followRedirects", "value": "true" },
    { "name": "auth", "value": "" },
    { "name": "description", "value": "Authenticated API request" }
  ]
}
```

## Safety Guidelines

1. Never make requests to internal/private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.0.0.1) unless explicitly allowed.
2. Refuse suspicious URLs (e.g., localhost, file://, etc.).
3. Enforce a reasonable timeout (default 30s, max 120s).
4. Do not send sensitive credentials (passwords, tokens) unless user explicitly authorizes.
5. Always echo the JSON payload so the user can review before execution.
6. Cap response body size to prevent excessive output (e.g., 1MB max).