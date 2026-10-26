import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { JsonParser, TextType } from './parser';
import { app } from 'electron';
import { logger } from './logger'
import { getAppHome } from './config';
import { Runtime } from '../common/common';
import { FullSkillConfig } from '../common/common';
import { ExecutionResponse, FENCE_RE } from '../common/common';

export type Executor = (jsonPayload: string, runtime?: Runtime) => ExecutionResponse | Promise<ExecutionResponse>;
export type ExecutorMap = Record<string, Executor>;
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
      console.error(error);
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

/**
 * A remote server entry discovered from the 'ssh' / 'scp' skill config items
 * in .skill.config. `name` is the config item name (the value the executor's
 * ssh/scp skills use to look the server up).
 */
export interface RemoteServer {
  name: string;
  skill: string;
  host?: string;
  port?: string;
  userName?: string;
  authType?: string;
}

/**
 * Return the list of configured remote servers, extracted from the 'ssh' and
 * 'scp' skills in .skill.config. The '.skill.config' structure is:
 *   { skill_configs: [ { skill: 'ssh'|'scp'|..., config_items: [
 *       { name: '<server-name>', value: { host, port, user_name, auth_type,
 *         pass, key_file } } ] } ] }
 * Server names are de-duplicated across the two skills (a server may be
 * declared under both 'ssh' and 'scp'; the first occurrence wins).
 */
export function getRemoteServers(): RemoteServer[] {
  const appHome = getAppHome();
  const configPath = path.join(appHome, ".skill.config");

  const servers: RemoteServer[] = [];
  const seen = new Set<string>();

  if (!fs.existsSync(configPath)) {
    return servers;
  }

  let fullConfig: any;
  try {
    fullConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    logger.log("Failed to read skill config for remote servers");
    return servers;
  }

  if (!fullConfig) {
    return servers;
  }

  const REMOTE_SKILLS = ['ssh', 'scp'];
  const axleList = fullConfig.skill_configs || [];
  for (const entry of axleList) {
    if (!REMOTE_SKILLS.includes(entry.skill)) {
      continue;
    }
    const configItems = entry.config_items || [];
    for (const item of configItems) {
      const serverName = item.name;
      if (!serverName || seen.has(serverName)) {
        continue;
      }
      seen.add(serverName);
      const value = item.value || {};
      servers.push({
        name: serverName,
        skill: entry.skill,
        host: value.host,
        port: value.port,
        userName: value.user_name,
        authType: value.auth_type,
      });
    }
  }

  return servers;
}

export function validate(input: string): [TextType, string, string] {
  const stripped = input.trim();
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
      if (beginning) {
        text += `${beginning}\n`
      }
      if (ending) {
        text += ending;
      }
    }

    return [textType, payload, text.trim()];
  } catch (error) {
    return [TextType.MALFORMATED_JSON, '', ''];
  }
}

export function resolveSkillConfig(fullSkillConfig: FullSkillConfig, skillName: string, name: string): Record<string, string> | null {
  let config = null;
  if (fullSkillConfig) {
    const axleList = fullSkillConfig.skill_configs || [];
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

  return config;
}


