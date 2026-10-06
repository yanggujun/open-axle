# 🗄️ Database Query Skill (db_accessor)

## Overview

This skill enables the LLM to execute SQL queries against a SAP HANA database by understanding the user's intent and producing a **strictly-formatted JSON output** that describes the query to run. The JSON output is then parsed by the `db_accessor` skill to connect to the database and return the result set.

## Skill Name

`db_accessor`

## When to Use This Skill

Invoke this skill whenever the user's request implies querying a database, running SQL, fetching data, or executing a stored procedure. Look for phrases such as:

- "run a query ..."
- "execute SQL ..."
- "select from ..."
- "fetch data from database ..."
- "get records ..."
- "query the database ..."

Do **NOT** use this skill when the user wants to:
- Read a file → use `file-reader`.
- Create a file → use `file-creator`.
- Make HTTP requests → use `curl`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **sql** (required): The SQL statement to execute.
   - **timeout** (optional): Maximum execution time in seconds. Defaults to `30`.
   - **allowModification** (optional): Whether to allow INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE. Defaults to `false`.
   - **max_rows** (optional): Maximun rows shown to user. Defaults to `100`.
   - **description** (optional): One-line summary of the query.
   - **database** (required): Database name described in the local configuration.
   - **sequential** (optional): If the result set is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

The LLM's response MUST be a pure JSON string with no code blocks.

```json
{
  "action": "access_db",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": ""
  },
  "properties": [
    {"name": "database", "value": "mysqllocall"},
    { "name": "sql",                "value": "SELECT * FROM TABLE" },
    { "name": "timeout",            "value": "30" },
    { "name": "allowModification",  "value": "false" }
  ]
}
```

### Field Rules

| Field              | Type    | Required | Notes                                                                 |
|--------------------|---------|----------|-----------------------------------------------------------------------|
| `action`           | string  | Yes      | Must be exactly `"access_db"`.                                          |
| `sql`              | string  | Yes      | The SQL statement to execute. Must be non-empty.                      |
| `timeout`          | string  | No       | Timeout in seconds as string. Default `"30"`.                        |
| `driver`           | string  | Yes      | Database driver identifier (e.g., `hdbcli`).                          |
| `allowModification`| string  | No       | `"true"` or `"false"`. Default `"false"`.                           |
| `max_rows`          | string  | No       | default to 100|
| `description`      | string  | No       | Human-readable purpose of the query.                                  |
| `database`      | string  | Yes       | Database name in the local configuration.                                  |
| `sequential`       | object  | No       | If the result should feed a follow-up AI task.                        |
| `prompt`           | string  | No       | Follow-up prompt when `sequential` is present.                         |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `access_db` payloads in a single response.


### Database Connection Configuration
The database configuration should always be in .axle in the working directory
Sample configuration:
```JSON
{
  {
    "skill_configs": [
        {
            "skill": "access_db",
            "config_items": [
                {
                    "name": "database name",
                    "value": {
                        "db_name": "database name",
                        "port": "50000",
                        "host": "db address",
                        "user_name": "user",
                        "pass": "password",
                        "type": "mysql",
                        "driver": "db_driver"
                      }
                },
                {
                    "name": "database name2",
                    "value": {
                        "port": "40000",
                        "address": "db address",
                        "user_name": "user",
                        "pass": "password",
                        "type": "mysql",
                        "driver": "db_driver"
                      }
                }
            ]
        }
    ]
  }
}
```

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "access_db",
>   "thinking": "User wants to fetch all customers.",
>   "properties": [
>     { "name": "sql",                "value": "SELECT * FROM CUSTOMERS" },
>     { "name": "timeout",            "value": "30" },
>     { "name": "database",            "value": "mysqllocal" },
>     { "name": "driver",             "value": "hdbcli" },
>     { "name": "allowModification",  "value": "false" },
>     { "name": "max_rows",  "value": "100" },
>     { "name": "description",        "value": "Fetch all customers" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply executing a database query?
    |     |
    |     +-- YES --> Extract sql/params/flags --> Emit ONE `access_db` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: Simple SELECT query
**User:** "Run `SELECT * FROM USERS` on the HANA database."

**LLM emits:**
```json
{
  "action": "access_db",
  "thinking": "User wants to select all users from the database.",
  "properties": [
    { "name": "database", "value": "mysql.local" },
    { "name": "driver", "value": "mysql.driver" },
    { "name": "sql", "value": "SELECT * FROM USERS" },
    { "name": "timeout", "value": "30" },
    { "name": "allowModification", "value": "false" }
    { "name": "max_rows", "value": "100" }
  ]
}
```

### Example 2: Query with explicit allowModification
**User:** "Insert a record into the LOG table. It's safe to modify."

**LLM emits:**
```json
{
  "action": "access_db",
  "thinking": "User explicitly allows modification, so allowModification is true.",
  "properties": [
    { "name": "database", "value": "mysql.local" },
    { "name": "driver", "value": "mysql.driver" },
    { "name": "sql", "value": "INSERT INTO LOG VALUES ('test')" },
    { "name": "timeout", "value": "30" },
    { "name": "allowModification", "value": "true" }
  ]
}
```

## Safety Guidelines

1. Never allow destructive SQL statements (DROP, TRUNCATE, DELETE, ALTER, UPDATE, INSERT) by default unless `allowModification` is explicitly set to `true`.
2. Refuse SQL that attempts to access system tables (e.g., `SYS.*`, `_SYS_*`) or sensitive data.
3. Enforce a reasonable timeout (default 30s, max 120s).
4. Limit the result set size to prevent excessive output (e.g., 10,000 rows max).
5. Always echo the JSON payload so the user can review before execution.
6. The connection details (host, port, user, password, database) must be provided in the properties; do not read them from external files without explicit user consent.
7. Do not expose the password in logs or error messages; mask it if shown.
