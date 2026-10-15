import * as os from 'os';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'node:path';
import { FullSkillConfig, SSH_SCHEME, WorkingDir } from '../common/common';


/**
 * Collapse runs of forward slashes into a single slash. This keeps parsing
 * robust against inputs like `ssh://server//foo///bar` or `a//b/c`.
 */
function collapseSlashes(value: string): string {
  return value.replace(/\/{2,}/g, '/');
}

/**
 * Remove a single trailing slash unless the value is just the root `/`.
 * Used to normalize both remote and local paths.
 */
function stripTrailingSlash(value: string): string {
  if (value.length > 1 && value.endsWith('/')) {
    return value.slice(0, -1);
  }
  return value;
}

export interface ModelConfig {
  name: string;
  url: string;
  key: string;
  model: string;
  skillsFolder: string;
  responses?: boolean;
  /** Whether this model's tab is open/active. Missing = treated as true. */
  active?: boolean;
  /** The working directory used by this model. */
  workingDir?: string;
}

export interface LlmConfigData {
  models: ModelConfig[];
}

export class LlmConfig {
  private config: LlmConfigData | null = null;
  private configPath: string | null = null;

  constructor() {

    const appHome = getAppHome();
    this.configPath = path.join(appHome, '.llm.config');

    if (fs.existsSync(this.configPath)) {
      logger.log(`Reading LLM configuration from ${appHome}`);
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (!parsed || !parsed.models || !Array.isArray(parsed.models)) {
        logger.log('No model is defined.');
      }

      this.config = parsed;
      if (this.config?.models) {
        for (const model of this.config?.models) {
          if (model.workingDir) {
            const workingDir = parsePath(model.workingDir);
            if (workingDir.kind === 'local' && !isDirectory(workingDir.path)) {
              model.workingDir = process.cwd();
            } else {
              model.workingDir = getFullWorkingPath(workingDir);
            }
          }
        }
      }
    }
  }

  /** Returns the raw parsed configuration object. */
  public getConfig(): LlmConfigData | null {
    return this.config;
  }

  /** Returns ALL configured model entries (including inactive/closed ones). */
  public getModels(): ModelConfig[] | undefined {
    return this.config?.models;
  }

  /** Returns only the ACTIVE model entries (active !== false). */
  public getActiveModels(): ModelConfig[] {
    return (this.config?.models ?? []).filter(m => m.active !== false);
  }

  /** Returns the first model matching the given name, or undefined if not found. */
  public getModel(name: string): ModelConfig | undefined {
    return this.config?.models?.find(m => m.name === name);
  }

  /** Returns the actual file path that was successfully loaded, or null if none. */
  public getConfigPath(): string | null {
    return this.configPath;
  }

  /**
   * Add a new model to the configuration and persist the change back to disk.
   * If no config file was found (configPath is null), this creates a new
   * .llm.config file in the current working directory.
   */
  public addModel(model: ModelConfig): void {
    if (!this.config) {
      this.config = { models: [] };
    }
    // Normalize: a missing `active` flag defaults to true (open).
    const normalized: ModelConfig = { ...model, active: model.active ?? true };
    // Avoid duplicate names; replace if exists.
    const idx = this.config.models.findIndex(m => m.name === normalized.name);
    if (idx >= 0) {
      this.config.models[idx] = normalized;
    } else {
      this.config.models.push(normalized);
    }
    this.save();
  }

  /**
   * Set the active (open) flag of a model by name and persist. Returns true if
   * the model was found and updated, false otherwise.
   */
  public setActive(name: string, active: boolean): boolean {
    const model = this.config?.models?.find(m => m.name === name);
    if (!model) {
      return false;
    }
    model.active = active;
    this.save();
    return true;
  }

  /**
   * Get the working directory for a model by name.
   */
  public getWorkingDir(name: string): string | undefined {
    return this.config?.models?.find(m => m.name === name)?.workingDir || process.cwd();
  }

  /**
   * Set the working directory for a model by name and persist to disk.
   */
  public setWorkingDir(name: string, dir: string): boolean {
    const model = this.config?.models?.find(m => m.name === name);
    if (!model) {
      return false;
    }
    model.workingDir = dir;
    this.save();
    return true;
  }

  /**
   * Persist the current configuration to disk. If configPath was discovered
   * during construction we write back to that file; otherwise we create a new
   * .llm.config in the current working directory.
   */
  public save(): void {
    if (!this.config) {
      return;
    }
    const targetPath = this.configPath || path.join(getAppHome(), ".llm.config");
    const json = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    this.configPath = targetPath;
  }
}


export function getAppHome(): string {
  const dirName = ".axle";

  const homeDir = os.homedir();
  const homeAppDir = path.join(homeDir, dirName);

  const processDir = process.cwd();
  const processAppDir = path.join(processDir, dirName);

  let home = '';
  if (isDirectory(processAppDir)) {
    home = processAppDir;
  } else if (isDirectory(homeAppDir)) {
    home = homeAppDir;
  } else {
    fs.mkdirSync(homeAppDir, { recursive: true });
    home = homeAppDir;
  }

  return home;
}

/**
 * Returns true if the given path exists and is a directory.
 */
function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}
/**
 * Flexible path parser used by {@link AxleAgent.cd}.
 *
 * When `input` has the form `ssh://<server>/<remotePath>` it is treated as a
 * remote path and the server and remote path are extracted. Otherwise the
 * input is treated as a local filesystem path (absolute or relative).
 *
 * The parser is intentionally forgiving:
 *  - leading/trailing whitespace is trimmed;
 *  - duplicate/extra slashes are collapsed;
 *  - a trailing slash is stripped (except for the root `/`);
 *  - a missing remote path defaults to `/`;
 *  - an empty server name throws a clear error.
 *
 * @throws Error when `input` is empty or when a remote URL has no server name.
 */

export function parsePath(input: string | undefined): WorkingDir {
  if (input === undefined || input === null) {
    throw new Error('parsePath: path must not be null or undefined.');
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('parsePath: path must not be empty.');
  }

  if (SSH_SCHEME.test(trimmed)) {
    // Strip the scheme, then split the first path separator off the host.
    const withoutScheme = trimmed.replace(SSH_SCHEME, '');
    const firstSlash = withoutScheme.indexOf('/');

    let server: string;
    let remotePath: string;
    if (firstSlash === -1) {
      // e.g. `ssh://server` -> no explicit remote path.
      server = withoutScheme;
      remotePath = '/';
    } else {
      server = withoutScheme.slice(0, firstSlash);
      remotePath = withoutScheme.slice(firstSlash);
    }

    server = server.trim();
    if (server === '') {
      throw new Error(`parsePath: remote path '${input}' is missing a server name.`);
    }
    const serverName = server;

    // Normalize the remote path: collapse extra slashes, default to '/',
    // ensure it is absolute, and drop any trailing slash.
    remotePath = collapseSlashes(remotePath.trim());
    if (remotePath === '' || remotePath === '/') {
      remotePath = '/';
    } else {
      if (!remotePath.startsWith('/')) {
        remotePath = '/' + remotePath;
      }
      remotePath = stripTrailingSlash(remotePath);
    }

    // Resolve the remote server configuration, preferring the 'ssh' skill and
    // falling back to 'scp'. getSkillConfig returns {} when not found, which
    // we treat as 'no match' and store as null.
    let config = getSkillConfig('ssh', serverName);
    if (!config || Object.keys(config).length === 0) {
      config = getSkillConfig('scp', serverName);
    }
    const resolvedServer = config && Object.keys(config).length > 0 ? config : null;

    return { kind: 'remote', serverName, path: remotePath, server: resolvedServer };
  }

  // Local path: collapse redundant slashes and drop a trailing slash, while
  // still allowing relative paths (we do not force a leading '/').
  const localPath = stripTrailingSlash(collapseSlashes(trimmed));
  return { kind: 'local', path: localPath };
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
      logger.log("Failed to read skill config");
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

/**
 * Reads the `.skill.config` file and returns ALL skill configs — every skill
 * entry together with all of its `config_items` — unlike {@link getSkillConfig}
 * which resolves only one skill's single config item value.
 *
 * When the config file is missing or unreadable, an empty {@link FullSkillConfig}
 * (with an empty `skill_configs` array) is returned.
 */
export function getFullSkillConfig(): FullSkillConfig {
  const appHome = getAppHome();
  let configPath = path.join(appHome, ".skill.config");

  let config: FullSkillConfig = { skill_configs: [] };
  if (fs.existsSync(configPath)) {
    let fullConfig: any;
    try {
      fullConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      logger.log("Failed to read skill config");
    }

    if (fullConfig) {
      const axleList = fullConfig.skill_configs || [];
      config = { skill_configs: axleList };
    }
  }

  return config;
}

export function getFullWorkingPath(workingDir: WorkingDir | undefined): string {
  let cwd = '';
  if (workingDir?.kind === 'remote') {
    cwd = `ssh://${workingDir.serverName}/${workingDir.path}`;
  } else {
    cwd = `${workingDir?.path}`;
  }

  return cwd;
}