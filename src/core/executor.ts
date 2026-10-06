import * as fs from 'fs';
import * as path from 'path';
import * as os from "os";
import { createRequire } from 'module';
import { JsonParser, InvalidFormatError, TextType } from './parser';
import { app } from 'electron';
import { logger } from './logger'
import { getAppHome } from './config';

export type Executor = (jsonPayload: string, baseDir?: string) => ExecutionResponse | Promise<ExecutionResponse>;
export type ExecutorMap = Record<string, Executor>;
// ---------------------------------------------------------------------------
// Execution response dataclass
// ---------------------------------------------------------------------------

export class ExecutionResponse {
  // Discriminating tag: allows realm-independent structural identification.
  // Using a literal-typed readonly field so it survives across duplicate
  // module copies (e.g. dynamically require()'d skill modules) where
  // `instanceof` would otherwise fail due to differing constructor identity.
  readonly kind = 'execution' as const;

  content: string;
  prompt: string;
  sequential: boolean;
  print: boolean;
  format: string;

  constructor(content: string, prompt: string, sequential: boolean = false, print: boolean = false, format: string = '') {
    this.content = content;
    this.prompt = prompt;
    this.sequential = sequential;
    this.print = print;
    this.format = format;
  }

  /**
   * Structural type guard. Prefer this over `x instanceof ExecutionResponse`.
   *
   * Skill modules are loaded at runtime via createRequire()/require() from the
   * compiled `dist/skills` directory. Those modules resolve their OWN copy of
   * this class, so an object a skill creates with `new ExecutionResponse(...)`
   * has a prototype pointing at a DIFFERENT constructor identity than the one
   * imported in the main bundle. As a result `instanceof` returns false even
   * for a perfectly valid ExecutionResponse. A structural check is immune to
   * this cross-module/realm duplication.
   */
  static isExecutionResponse(x: unknown): x is ExecutionResponse {
    if (x === null || typeof x !== 'object') {
      return false;
    }
    const o = x as Record<string, unknown>;
    return (
      o.kind === 'execution' ||
      (typeof o.content === 'string' &&
        typeof o.prompt === 'string' &&
        typeof o.sequential === 'boolean' &&
        typeof o.print === 'boolean' &&
        typeof o.format === 'string')
    );
  }
}

// ---------------------------------------------------------------------------
// JSON payload parsing (property-list format)
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:[a-zA-Z0-9_\-]+)?\s*\n([\s\S]*?)\n```/;

function _strip_fences(text: string): string {
  const match = FENCE_RE.exec(text);
  if (match) {
    return match[1].trim();
  }
  return text.trim();
}

export function parseActionJson(payload: string | Record<string, any>): Record<string ,any> {
  let isJson = false;
  let data: Record<string, any> = {};

  if (typeof payload === 'object' && payload !== null) {
    data = payload as Record<string, any>;
    isJson = true;
  } else if (typeof payload === 'string') {
    let text = _strip_fences(payload);
    // If the string still has junk around the JSON, isolate the outermost {}
    if (!text.startsWith('{')) {
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first !== -1 && last > first) {
        text = text.substring(first, last + 1);
      }
    }
    try {
      data = JSON.parse(text);
      isJson = true;
    } catch (exc) {
      logger.log(`not json: ${exc}`);
    }
  } else {
    throw new Error(`Unsupported payload type: ${typeof payload}`);
  }

  return data;
}

export async function discoverExecutors(
  skillsDir: string = path.join(__dirname, 'skills')
): Promise<ExecutorMap> {
  const registry: ExecutorMap = {};
  let skillsPath = skillsDir;
  if (!path.isAbsolute(skillsPath)) {
    if (app.isPackaged) {
      skillsPath = path.join(process.resourcesPath, skillsDir);
    } else {
      const devSrcPath = path.join(app.getAppPath(), 'dist', skillsDir);
      skillsPath = devSrcPath;
    }
  }

  if (!fs.existsSync(skillsPath) || !fs.statSync(skillsPath).isDirectory()) {
    logger.log(`The skills directory ${skillsPath} is not found`)
    return registry;
  }

  const files = collectJsFiles(skillsPath);

  for (const file of files) {
    try {
      // Dynamically load the module at runtime. Build an absolute path so
      // Node's resolver receives a fully-qualified path (notably on Windows).
      const absPath = path.resolve(file);
      const requireSkill = createRequire(__filename);
      //const mod = await import(pathToFileURL(absPath).href) as Record<string, any>
      const mod = requireSkill(absPath) as Record<string, any>;

      // (2) Validate the module truly exports ACTION_NAME (string) AND a callable
      // execute before registering it.
      const actionName = mod.ACTION_NAME;
      if (typeof actionName !== 'string' || actionName.trim() === '') {
        continue;
      }

      const executeFn = resolveExecutor(mod);
      if (typeof executeFn !== 'function') {
        continue;
      }

      if (registry[actionName]) {
        // Avoid clobbering: warn about duplicate ACTION_NAME registrations.
        // eslint-disable-next-line no-console
        logger.log(`Duplicate ACTION_NAME '${actionName}' found in ${file}; keeping first registration.`);
        continue;
      }

      logger.log(`find executor ${file} for ${actionName}`)
      registry[actionName] = executeFn;
    } catch (error) {
      // Not loadable (syntax error, missing deps, etc.): skip silently.
      logger.log(`Error loading executors: ${error}`)
      continue;
    }
  }

  return registry;
}

function resolveExecutor(mod: Record<string, any>): Executor | null {
  if (typeof mod["execute"] === 'function') {
    return mod["execute"] as Executor;
  }
  return null;
}

function collectJsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory: skip silently.
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
        continue;
      }
      collectJsFiles(full, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sequential and execution helpers
// ---------------------------------------------------------------------------

export function getSequential(payload: Record<string, any>): [boolean, string] {
  const seq = payload.sequential;
  let sequential = false;
  let nextPrompt = '';
  if (seq) {
    sequential = true;
    const prmt = seq.prompt;
    if (prmt) {
      nextPrompt = prmt;
    }
  }
  return [sequential, nextPrompt];
}

export function extractJson(payload: string | Record<string, any>): Record<string, any> | null {
  if (typeof payload === 'object' && payload !== null) {
    return payload;
  }
  if (typeof payload !== 'string') {
    return null;
  }

  let text = payload.trim();
  const match = FENCE_RE.exec(text);
  if (match) {
    text = match[1].trim();
  }
  if (!text.startsWith('{')) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    logger.log(`Invalid JSON payload: ${error}`);
    return {
      properties: [
        {
          name: 'output',
          value: text
        }
      ]
    };
  }
}

export function getSkillConfig(skillName: string, name: string): Record<string, string> {
  const appHome = getAppHome();
  let configPath = path.join(appHome, ".skill.config");

  let config: Record<string, string> = {};
  if (fs.existsSync(configPath)) {
    let fullConfig: any;
    try {
      fullConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      logger.log("Failed to read skill config")
    }

    if (fullConfig) {
      const axleList = fullConfig.skill_configs || [];
      for (const entry of axleList) {
        if (entry.skill === skillName) {
          const configItems = entry.config_items || [];
          for (const item of configItems) {
            if (item.name === name) {
              config = item.value;
              break;
            }
          }
          break;
        }
      }
    }
  }

  return config;
}

export function validate(text: string): [TextType, string, string] {
  const stripped = text.trim();
  try {
    const parser = new JsonParser();
    parser.parse(stripped);
    const textType = parser.getTextType();
    let payload = '';
    let text = '';
    if (textType == TextType.JSON || textType == TextType.TRAILING_JSON) {
      const jsonStartPos = parser.getStartPos();
      const jsonEndPos = parser.getEndPos();
      const beginning = stripped.substring(0, jsonStartPos).trim();
      const ending = stripped.substring(jsonEndPos).trim();
      payload = stripped.substring(jsonStartPos, jsonEndPos).trim();
      text = `${beginning}\n${ending}`;
    }

    return [textType, payload, text];
  } catch (error) {
    return [TextType.MALFORMATED_JSON, '', ''];
  }
}

// ---------------------------------------------------------------------------
// Code file reading with code-fence wrapping
// ---------------------------------------------------------------------------

// Mapping of known code file extensions to the markdown code-fence language tag.
const CODE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.java': 'java',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.c': 'c',
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'bash',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

/**
 * Reads a file given its path and, if the file extension corresponds to a
 * known code format, wraps the file content with a markdown code fence using
 * the appropriate language tag and returns the fenced content.
 *
 * @param filePath The path of the file to read.
 * @returns The file content wrapped in a code fence (with the language tag) if
 *          the extension is a known code format; otherwise an empty string.
 */
export function readFile(filePath: string, startLine: number = 0, endLine: number = 0 , maxBytes: number = 0): string {
  const ext = path.extname(filePath).toLowerCase();
  const language = CODE_EXTENSION_LANGUAGE_MAP[ext];

  let content: string;
  try {
    if (endLine > 0 || startLine > 1) {
      // Line-range read.
      const full = fs.readFileSync(filePath, 'utf-8');
      const lines = full.split(/\r?\n/);
      const start = Math.max(1, startLine);
      const end = endLine > 0 ? endLine : lines.length;
      const endIdx = Math.min(end, lines.length);
      content = lines.slice(start - 1, endIdx).join('\n');
    } else if (maxBytes > 0) {
      content = fs.readFileSync(filePath, 'utf-8').substring(0, maxBytes);
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    logger.log(`Failed to read file ${filePath}: ${error}`);
    return '';
  }

  if (!language) {
    // Not a known code format: return the raw file content directly.
    return content;
  }

  return '```' + language + '\n' + content + '\n```';
}
