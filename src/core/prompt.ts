import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { logger } from './logger';
import { execCommand } from '../common/common';
import { connect } from '../common/common';
import { buildConnectConfig } from '../common/common';
import { WorkingDir } from '../common/common';
import { Client } from 'ssh2';

/**
 * AxlePrompt encapsulates the system-prompt assembly and skill management
 * that used to live inside the Model class.
 *
 * - Skills are stored in a map (`skillsContent`) keyed by skill name.
 * - The assembled system prompt is cached (`_cachedSystemPrompt`) and is only
 *   rebuilt when skills are (re)loaded.
 */
export class AxlePrompt {
  skillsFolder: string;
  skillsContent: Record<string, string> = {};
  selectedSkills: string[] = [];
  private osPrompt: string | null = null;
  private _cachedSystemPrompt: string | null = null;

  constructor(skillsFolder: string = 'skills') {
    this.skillsFolder = skillsFolder;
    if (!path.isAbsolute(this.skillsFolder)) {
      if (app.isPackaged) {
        this.skillsFolder = path.join(process.resourcesPath, this.skillsFolder);
      } else {
        const devSrcPath = path.join(app.getAppPath(), 'src', this.skillsFolder);
        this.skillsFolder = devSrcPath;
      }
    }

    this.skillsContent = {};
    this._loadSkills();
    this.osPrompt = `${os.type()} ${os.release()}`;
  }

  /**
   * Load ALL available skills from the skills folder into the skills map.
   */
  private _loadSkills(): void {
    this.skillsContent = {};

    if (!fs.existsSync(this.skillsFolder) || !fs.statSync(this.skillsFolder).isDirectory()) {
      logger.log(`Skills folder '${this.skillsFolder}' not found.`);
      this._invalidateCache();
      return;
    }

    const entries = fs.readdirSync(this.skillsFolder).sort();
    for (const entry of entries) {
      const skillDir = path.join(this.skillsFolder, entry);
      if (!fs.statSync(skillDir).isDirectory()) {
        continue;
      }
      if (entry.startsWith('__') || entry.startsWith('.')) {
        continue;
      }

      const content = this._readSkillContent(entry);
      if (content !== null) {
        this.skillsContent[entry] = content;
        this.selectedSkills.push(entry);
      }
    }

    this._invalidateCache();
    logger.log(`Loaded ${Object.keys(this.skillsContent).length} skill(s) from '${this.skillsFolder}/'`);
  }

  /**
   * Read a single skill's SKILL.md content. Returns null when missing/unreadable.
   */
  private _readSkillContent(skillName: string): string | null {
    const skillDir = path.join(this.skillsFolder, skillName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile()) {
      try {
        return fs.readFileSync(skillMdPath, 'utf8');
      } catch (e: any) {
        logger.log(`Error loading skill '${skillName}': ${e}`);
      }
    }
    return null;
  }

  async buildOsPrompt(workingDir: WorkingDir): Promise<void> {
    if (!workingDir || workingDir.kind === 'local') {
      this.osPrompt = `${os.type()} ${os.release()}`;
    } else {
      this.osPrompt = await this._detectRemoteOsPrompt(workingDir);
    }
    logger.log(`Current OS: ${this.osPrompt}`);
    this._invalidateCache();
  }

  /**
   * Detect the operating system type and version of a remote server reached
   * over SSH and return it as a display string, mirroring the local form
   * `${os.type()} ${os.release()}`. The connection is established with the
   * shared SSH helpers from executor.ts, reusing the server configuration
   * resolved on the remote WorkingDir.
   */
  private async _detectRemoteOsPrompt(
    workingDir: { serverName: string; path: string; server: Record<string, string> | null }
  ): Promise<string> {
    const serverName = workingDir.serverName;
    const server = workingDir.server;
    if (!server) {
      logger.log(`No SSH server configuration found for '${serverName}'.`);
      return `remote server '${serverName}' (OS unknown)`;
    }

    let conn: Client | null = null;
    try {
      conn = await connect(buildConnectConfig(serverName, server));

      // Prefer PRETTY_NAME from /etc/os-release (e.g. "Ubuntu 22.04.3 LTS").
      let osType = '';
      const osRelease = await execCommand(conn, "grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null || true");
      if (osRelease.code === 0) {
        const line = osRelease.stdout.trim();
        const idx = line.indexOf('=');
        if (idx !== -1) {
          let name = line.substring(idx + 1).trim();
          if (name.startsWith('"') && name.endsWith('"')) {
            name = name.slice(1, -1);
          }
          osType = name;
        }
      }

      // Fall back to /etc/issue when os-release is unavailable.
      if (!osType) {
        const issue = await execCommand(conn, 'head -n1 /etc/issue 2>/dev/null || true');
        if (issue.code === 0) {
          osType = issue.stdout.trim();
        }
      }

      // Kernel name and release provide the OS type/version fallback.
      const unameS = await execCommand(conn, 'uname -s');
      const unameR = await execCommand(conn, 'uname -r');
      const kernelName = unameS.code === 0 ? unameS.stdout.trim() : '';
      const kernelRelease = unameR.code === 0 ? unameR.stdout.trim() : '';
      const kernel = `${kernelName} ${kernelRelease}`.trim();

      if (osType && kernel) {
        return `${osType} (${kernel})`;
      }
      if (osType) {
        return osType;
      }
      if (kernel) {
        return kernel;
      }
      return `remote server '${serverName}' (OS unknown)`;
    } catch (e: any) {
      logger.log(`Failed to detect OS on remote server '${serverName}': ${e}`);
      return '';
    } finally {
      if (conn) {
        try {
          conn.end();
        } catch {
          // ignore close errors
        }
      }
    }
  }

  /**
   * Load only the skills whose names are provided, merging them into the
   * skills map. Loading skills invalidates the cached system prompt so it is
   * rebuilt on next access.
   */
  loadSkills(skillNames: string[]): void {
    if (!skillNames || skillNames.length === 0) {
      return;
    }

    this.selectedSkills = [];
    for (const skillName of skillNames) {
      if (this.skillsContent[skillName]) {
        this.selectedSkills.push(skillName);
      }
    }

    this._invalidateCache();
    logger.log(`Loaded ${skillNames.length} requested skill(s); total ${Object.keys(this.skillsContent).length} skill(s).`);
  }

  private _invalidateCache(): void {
    this._cachedSystemPrompt = null;
  }

  /**
   * Return the (cached) assembled system prompt. The prompt is only rebuilt
   * when the cache has been invalidated by a skill load.
   */
  getSystemPrompt(): string {
    if (this._cachedSystemPrompt === null) {
      this._cachedSystemPrompt = this._buildSystemPrompt();
    }
    return this._cachedSystemPrompt;
  }

  private _buildSystemPrompt(): string {
    logger.log("Creating system prompt...");
    const parts: string[] = [];

    parts.push(
      "You are an intelligent AI assistant equipped with specialized skills, and always generate formatted output in JSON. " +
      "You should use these skills when appropriate to help the user effectively.\n" +
      "\n" +
      "## Your Capabilities\n" +
      "\n" +
      "Below are the skills available to you. Each skill has a description and " +
      "guidelines for when and how to use it.\n"
    );

    logger.log(`OS: ${this.osPrompt}`);
    if (this.osPrompt) {
      parts.push(`The current operating system is ${this.osPrompt}. You should provide operating system specific commands and analysis for operating system related tasks.\n`);
    }

    if (this.selectedSkills.length > 0) {
      for (const skillName of this.selectedSkills) {
        const content = this.skillsContent[skillName];
        parts.push(`\n---\n### Skill: \`${skillName}\`\n\n${content}\n`);
      }
    } else {
      parts.push("\n(No skills are currently loaded. Respond using your general knowledge.)\n");
    }

    parts.push(
      "\n---\n" +
      "## General Guidelines\n" +
      "\n" +
      "- Use skills when the user's request matches a skill's trigger conditions.\n" +
      "- If no skill is relevant, respond using your general knowledge.\n" +
      "- Be concise, accurate, and helpful.\n" +
      "- When executing skill-related tasks, follow the skill's documented patterns.\n"
    );

    const systemMdPath = path.join(this.skillsFolder, 'SYSTEM.md');
    if (fs.existsSync(systemMdPath) && fs.statSync(systemMdPath).isFile()) {
      try {
        const systemMdContent = fs.readFileSync(systemMdPath, 'utf8');
        parts.push(`\n---\n${systemMdContent}\n`);
        logger.log(`Loaded system instructions from '${systemMdPath}'`);
      } catch (e: any) {
        logger.log(`Error loading SYSTEM.md: ${e}`);
      }
    }

    return parts.join('');
  }

  reloadSkills(): void {
    logger.log('\nReloading skills...');
    this._loadSkills();
    logger.log('Skills reloaded successfully.');
  }

  getSkillsSummary(): string {
    if (this.selectedSkills.length === 0) {
      return 'No skills loaded.';
    }

    const lines: string[] = ['Loaded Skills:'];
    lines.push('-'.repeat(40));
    let i = 1;
    for (const skillName of this.selectedSkills) {
      lines.push(`  ${i}. ${skillName}`);
      i++;
    }
    lines.push('-'.repeat(40));
    lines.push(`Total: ${Object.keys(this.selectedSkills).length} skill(s)`);
    return lines.join('\n');
  }
}
