import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

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
          if (model.workingDir != null && !isDirectory(model.workingDir)) {
            model.workingDir = process.cwd();
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
  if (isDirectory(homeAppDir)) {
    home = homeAppDir;
  } else if (isDirectory(processAppDir)) {
    home = processAppDir;
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