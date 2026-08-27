"""
Harness Executor
================
Searches all Python files under the `skills/` folder recursively, discovers
every top-level function defined in those files, and executes the one whose
name matches the requested function name.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
import importlib.util
import json
import os
import re
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple, Union


SKILLS_DIR = "skills"


# ---------------------------------------------------------------------------
# Decorator for harness executor functions
# ---------------------------------------------------------------------------

# Attribute name used to attach metadata onto decorated functions.
HARNESS_METADATA_ATTR = "__axle_metadata__"


def AxleExecutor(
    action: Optional[str] = None,
    description: str = "",
    version: str = "0.0.0",
    **extra: Any,
):
    """
    Decorator that tags a function as an "open harness executor" and attaches
    metadata that can be read back at runtime (see `execute`).

    Usage:

        @AxleExcutor(
            action="create_file",
            description="Create a file from a JSON payload.",
            version="1.0.0",
        )
        def create_file(json_payload, base_dir=""):
            ...

    The metadata dict is stored on the function object under the attribute
    named by `HARNESS_METADATA_ATTR` (default: `__harness_metadata__`).
    """
    def _decorator(func):
        metadata: Dict[str, Any] = {
            "action": action,
            "description": description,
            "version": version,
            "function_name": func.__name__,
            "module": getattr(func, "__module__", None),
            **extra,
        }
        setattr(func, HARNESS_METADATA_ATTR, metadata)
        return func
    return _decorator


@dataclass
class ExecutionResponse:
    content: str
    prompt: str
    sequential: bool = False
    print: str = False



# ---------------------------------------------------------------------------
# JSON payload parsing (property-list format)
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(
    r"```(?:[a-zA-Z0-9_\-]+)?\s*\n(?P<body>.*?)\n```",
    re.DOTALL,
)


def _strip_fences(text: str) -> str:
    """If `text` is wrapped in a ``` fenced block, return the inner body."""
    match = _FENCE_RE.search(text)
    if match:
        return match.group("body").strip()
    return text.strip()


def parse_action_json(payload: Union[str, Dict[str, Any]]) -> str:
    # 1) Normalize the input into a dict.
    isJson = False
    if isinstance(payload, dict):
        data = payload
        isJson = True
    elif isinstance(payload, str):
        text = _strip_fences(payload)
        # If the string still has junk around the JSON, isolate the outermost {}
        if not text.startswith("{"):
            first = text.find("{")
            last = text.rfind("}")
            if first != -1 and last > first:
                text = text[first : last + 1]
        try:
            data = json.loads(re.sub(r',(\s*[}\]])', r'\1', text))
            isJson = True
        except json.JSONDecodeError as exc:
            print(f"not json: {exc}")
    else:
        raise ValueError(f"Unsupported payload type: {type(payload).__name__}")

    if isJson:
        # 2) Validate top-level fields.
        action = data.get("action")
        return action
    return ""


def _iter_python_files(root: str) -> List[str]:
    """Recursively yield all .py files under `root`."""
    py_files: List[str] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.endswith(".py"):
                py_files.append(os.path.join(dirpath, fn))
    return py_files


def _load_func_from_path(module_name: str, func_name: str, file_path: str) -> Any:
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    if hasattr(module, func_name):
        func = getattr(module, func_name)
        print(f"[axle] function {func_name} found in {file_path}")
        return func
    else:
        print(f"[axle] Function '{func_name}' not found.")


# ---------------------------------------------------------------------------
# AxleExecutor-based discovery
# ---------------------------------------------------------------------------

def _decorator_names(node: ast.AST) -> List[str]:
    """
    Return the "callable names" mentioned in a function's decorator list.
    Handles both bare (`@AxleExecutor`) and called (`@AxleExecutor(...)`)
    forms, and both plain names (`AxleExecutor`) and attribute access
    (`some_module.AxleExecutor`).
    """
    names: List[str] = []
    decorators = getattr(node, "decorator_list", []) or []
    for dec in decorators:
        # Unwrap `@Foo(...)` -> `Foo`
        if isinstance(dec, ast.Call):
            dec = dec.func
        if isinstance(dec, ast.Name):
            names.append(dec.id)
        elif isinstance(dec, ast.Attribute):
            names.append(dec.attr)
    return names


def _functions_decorated_with(path: str, decorator_name: str) -> List[str]:
    """
    Return names of top-level functions in `path` that are decorated with
    a decorator whose (short) name equals `decorator_name`.
    Purely AST-based; the module is NOT imported.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
    except (OSError, SyntaxError) as exc:
        print(f"[axle_executor] Skipping {path}: {exc}")
        return []

    matches: List[str] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if decorator_name in _decorator_names(node):
                matches.append(node.name)
    return matches


def discover_axle_executors(
    skills_dir: str = SKILLS_DIR,
    decorator_name: str = "AxleExecutor",
    load_metadata: bool = True,
) -> Dict[str, List[Tuple[str, str, Optional[Dict[str, Any]]]]]:
    discovered: Dict[str, List[Tuple[str, str, Optional[Dict[str, Any]]]]] = {}

    if not os.path.isdir(skills_dir):
        print(f"[axle_executor] Skills directory not found: {skills_dir}")
        return discovered

    for py_file in _iter_python_files(skills_dir):
        fn_names = _functions_decorated_with(py_file, decorator_name)
        if not fn_names:
            continue

        module = None
        if load_metadata:
            # Import the module once so we can read the metadata attribute
            # off each decorated function.
            module_name = (
                "axle_scan_"
                + re.sub(r"[^A-Za-z0-9_]", "_", os.path.splitext(py_file)[0])
            )
            try:
                spec = importlib.util.spec_from_file_location(module_name, py_file)
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
            except Exception as exc:  # noqa: BLE001
                print(f"[axle_executor] Failed to import {py_file}: {exc}")
                module = None

        for fn_name in fn_names:
            metadata: Optional[Dict[str, Any]] = None
            if module is not None:
                fn = getattr(module, fn_name, None)
                if fn is not None:
                    metadata = getattr(fn, HARNESS_METADATA_ATTR, None)
                    if metadata is None:
                        print(
                            f"[axle_executor] '{fn_name}' in {py_file} is "
                            f"decorated with @{decorator_name} but has no "
                            f"metadata attribute ({HARNESS_METADATA_ATTR})."
                        )

            discovered.setdefault(metadata["action"], []).append((py_file, fn_name))

    return discovered


def getSequential(payload: Dict[str, Any]):
    seq = payload.get("sequential")
    sequential = False
    nextPrompt = ""
    if seq:
       sequential = True 
       prmt = seq.get("prompt")
       if prmt:
           nextPrompt = prmt
    return sequential, nextPrompt

def execute(json_payload: str, executors: Dict[str, List[Tuple[str, str]]], base_dir: str) -> ExecutionResponse:

        action = parse_action_json(json_payload)
        if action in executors:
            print(f"\n[axle] executor {action} found")
            matches = executors[action]
            for file_path, fn_name in matches:

                fn = _load_func_from_path(fn_name+"mod", fn_name, file_path)
                if fn is None or not callable(fn):
                    print(f"[axle] '{fn_name}' not callable in {file_path}")
                    continue

                try:
                    return fn(json_payload, base_dir)
                except Exception as exc:
                    print(f"[axle] Error while running '{fn_name}': {exc}")
                    traceback.print_exc()
        else:
            print(f"no action is defined")
            data = extract_json(json_payload)
            properties = {p["name"]: p["value"] for p in data.get("properties", [])}
            content = ""
            for k in properties:
                content += properties.get(k) + "\n"

            toPrint = False
            if len(properties) > 0:
                toPrint = True

            return ExecutionResponse(content = content, prompt = "", sequential = False, print = toPrint)

def extract_json(payload: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    Accept a JSON string, a fenced code block, or a dict and return a dict.

    Raises:
        ValueError: If the payload cannot be parsed as valid JSON.
    """
    if isinstance(payload, dict):
        return payload

    if not isinstance(payload, str):
        raise ValueError(f"Unsupported payload type: {type(payload).__name__}")

    text = payload.strip()

    # If fenced, extract the body.
    match = _FENCE_RE.search(text)
    if match:
        text = match.group("body").strip()

    # If it still doesn't look like JSON, try to locate the first '{'.
    if not text.startswith("{"):
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace != -1 and last_brace > first_brace:
            text = text[first_brace : last_brace + 1]

    try:
        return json.loads(re.sub(r',(\s*[}\]])', r'\1', text))
    except json.JSONDecodeError as exc:
        print (f"Invalid JSON payload: {exc}")
        return {
            "properties": [
                {
                    "name": "output",
                    "value": text
                }
            ]
        }

def get_skill_config(skill_name: str, name:str) -> Dict[str, str]:
    axle_file_path = os.path.join(os.getcwd(),".axle");
    # Read and parse the .axle file
    try:
        with open(axle_file_path, "r") as f:
            full_config = json.load(f)
    except (json.JSONDecodeError, IOError) as exc:
        raise ValueError(f"Failed to read .axle file: {exc}")

    # Locate the 'access_db' skill configuration
    config = {}
    axle_list = full_config.get("skill_configs", [])
    for entry in axle_list:
        if entry.get("skill") == skill_name:
            config_items = entry.get("config_items", [])
            for item in config_items:
                if item.get("name") == name:
                    config = item.get("value")
                    break;
            break;

    return config