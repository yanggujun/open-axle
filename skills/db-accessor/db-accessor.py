from __future__ import annotations

import json
import importlib
from typing import Any, Dict, Optional, Union

from axle_executor import AxleExecutor, ExecutionResponse, extract_json, get_skill_config, getSequential

# ---------------------------------------------------------------------------
# Safety - Default: read-only queries
# ---------------------------------------------------------------------------

READ_ONLY_COMMANDS = {"select", "show", "describe", "explain", "with"}
WRITE_COMMANDS = {"insert", "update", "delete", "drop", "alter", "truncate", "create", "replace", "merge"}

DEFAULT_TIMEOUT = 30


def _is_dangerous_sql(sql: str) -> Optional[str]:
    """Check if the SQL statement contains write/DDL commands.
    Returns the first offending command found, or None if safe."""
    normalized = sql.strip().lower()
    tokens = normalized.split()
    if not tokens:
        return None
    first_word = tokens[0].rstrip(";")
    if first_word in WRITE_COMMANDS:
        return first_word
    return None


def _to_int(value: Any, default: int) -> int:
    """Convert a string/number/None to an int, falling back to default."""
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any, default: bool) -> bool:
    """Convert a string to bool, falling back to default."""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def _normalize(
    payload: Dict[str, Any],
    base_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Validate required fields and fill in defaults.
    Connection parameters are loaded from .axle file based on database name.
    Returns a normalized dict.
    """
    action = payload.get("action", "access_db")
    sequential, next_prompt = getSequential(payload)

    if action != "access_db":
        raise ValueError(f"Unsupported action: {action!r}")

    # -----------------------------------------------------------------------
    # 1) Extract fields from payload
    # -----------------------------------------------------------------------
    properties = {p["name"]: p["value"] for p in payload.get("properties", [])}
    sql = properties.get("sql", "")
    timeout = _to_int(properties.get("timeout"), DEFAULT_TIMEOUT)
    allow_modification = _to_bool(properties.get("allowModification"), False)
    encoding = properties.get("encoding", "utf-8") or "utf-8"
    max_rows = _to_int(properties.get("max_rows"), 100)
    requested_db = properties.get("database", "")  # Database name from payload

    if not sql:
        raise ValueError("Missing required field: 'sql'")
    if not requested_db:
        raise ValueError("Missing required field: 'database'")

    # -----------------------------------------------------------------------
    # 2) Load configuration from .axle file
    # -----------------------------------------------------------------------
    db_config = get_skill_config("access_db", requested_db)
    
    if not db_config:
        raise ValueError(
            f"Database '{requested_db}' not found in .axle configuration. "
        )

    # Extract connection fields from config
    host = db_config.get("host", "")
    port = _to_int(db_config.get("port"), 30015)
    user = db_config.get("user_name", "")
    password = db_config.get("pass", "")
    db_type = db_config.get("type", "")
    driver = db_config.get("driver", "")
    db_name = db_config.get("db_name", "")

    # Validate required fields
    if not host:
        raise ValueError("Missing required field 'address' in .axle config")
    if not user:
        raise ValueError("Missing required field 'user_name' in .axle config")
    if not password:
        raise ValueError("Missing required field 'pass' in .axle config")
    if not driver:
        raise ValueError("Missing required field 'driver' in .axle config")

    # -----------------------------------------------------------------------
    # 3) Safety: restrict dangerous commands unless explicitly allowed
    # -----------------------------------------------------------------------
    if not allow_modification:
        dangerous = _is_dangerous_sql(sql)
        if dangerous:
            raise ValueError(
                f"SQL statement contains '{dangerous}' which is a write/DDL command. "
                f"Set 'allowModification': true to permit write operations."
            )

    return {
        "action": action,
        "sql": sql,
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "database": requested_db,
        "db_name": db_name,
        "database_type": db_type,
        "driver": driver,
        "timeout": timeout,
        "allow_modification": allow_modification,
        "max_rows": max_rows,
        "encoding": encoding,
        "sequential": sequential,
        "prompt": next_prompt,
    }


# ---------------------------------------------------------------------------
# Core DB query execution
# ---------------------------------------------------------------------------


def execute_db_accessor_from_payload(
    payload: Union[str, Dict[str, Any]],
    base_dir: Optional[str] = None,
) -> str:
    try:
        raw = extract_json(payload)
        data = _normalize(raw, base_dir=base_dir)
    except (ValueError, json.JSONDecodeError) as exc:
        return f"Invalid payload: {exc}"

    sql = data["sql"]
    host = data["host"]
    port = data["port"]
    user = data["user"]
    password = data["password"]
    database = data["database"]
    driver = data["driver"]
    timeout = data["timeout"]
    max_rows = data["max_rows"]
    db_name = data["db_name"]

    # Dynamically import the database driver
    try:
        db_driver = importlib.import_module(driver)
    except ImportError:
        return f"Error: Driver '{driver}' is not installed. Please install it."

    # Connect and execute
    try:
        conn = db_driver.connect(
            address=host,
            port=port,
            user=user,
            password=password,
            currentSchema=db_name,
            timeout=timeout,
        )
        cursor = conn.cursor()
        cursor.execute(sql)
        
        # Determine if the statement returns rows (SELECT-like) or not
        if cursor.description is not None:
            rows = cursor.fetchall()
            columns = [desc[0] for desc in cursor.description]
            result = format_read_result(columns, rows, max_rows)
        else:
            result = f"sql execution succeeded. affected rows: {cursor.rowcount}"
        
        cursor.close()
        conn.close()
    except Exception as e:
        result = f"sql execution failed. error: {str(e)}"

    # Format output as a JSON string (pretty-printed if possible)
    seq = data["sequential"]
    content = result
    return ExecutionResponse(
        content=content,
        prompt=data["prompt"],
        sequential=seq,
        print=not seq,
    )


def format_read_result(columns, rows, max_rows) -> str:
    """Format query results into a readable string."""
    result = "sql execution succeeded\n"
    sep = "   |   "
    result += sep.join(columns) + "\n"
    result += "-" * (len(sep) * (len(columns) - 1) + sum(len(col) for col in columns)) + "\n"
    
    index = 0
    for row in rows:
        index += 1
        if index > max_rows:
            break
        # Convert each value to string
        str_row = [str(val) if val is not None else "NULL" for val in row]
        result += sep.join(str_row) + "\n"
    
    result += f"\ntotal rows returned: {min(index - 1, len(rows))}"
    if len(rows) > max_rows:
        result += f" (truncated, total: {len(rows)})"
    return result


# ---------------------------------------------------------------------------
# Skill wrapper function (called by the SkillManager)
# ---------------------------------------------------------------------------


def skill_db_accessor_execute(json_payload: str, base_dir: str = "") -> str:
    return execute_db_accessor_from_payload(
        json_payload,
        base_dir=base_dir.strip() or None,
    )


__all__ = [
    "execute_db_accessor_from_payload",
    "skill_db_accessor_execute",
]


@AxleExecutor(
    action="access_db",
    description="Execute a SQL query against a database using a dynamic driver.",
    version="1.2.0",
)
def execute_db_accessor(json_payload: str, base_dir: str = "") -> Dict[str, str]:
    return skill_db_accessor_execute(json_payload, base_dir)
