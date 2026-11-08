import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { logger } from './logger';
import { execCommand } from '../common/common';
import { WorkingDir } from '../common/common';
import { shellQuote } from '../common/common';
import { SshTarget } from './remote';
import { buildSshCacheKey, buildSshConnectConfig, getSshConn } from './remote';

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

  /**
   * Local-side prompt state. `projectPrompts` holds the Markdown prompt files
   * loaded from `<workingDir>/.axle/*.md` by `buildDirPrompt`; each entry is
   * shaped as `{ name: <file name>, content: <file content> }`.
   */
  local: { projectPrompts: Array<{ name: string; content: string }> } = { projectPrompts: [] };

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
    this.buildDirPrompt(workingDir);
    this._invalidateCache();
  }

  /**
   * Detect the operating system type and version of a remote server reached
   * over SSH and return it as a display string, mirroring the local form
   * `${os.type()} ${os.release()}`. The connection is established with the
   * shared SSH helpers from executor.ts, reusing the server configuration
   * resolved on the remote WorkingDir.
   */
  /**
   * Map a resolved skill-config server entry onto the SshTarget descriptor
   * consumed by the cached connection manager in remote.ts.
   */
  private _toSshTarget(serverName: string, server: Record<string, string>): SshTarget {
    return {
      host: server.host || serverName,
      port: server.port ? parseInt(server.port, 10) : 22,
      user: server.user_name || server.userName || server.user || '',
      authType: (server.auth_type || server.authType || 'password').toLowerCase(),
      keyFile: server.key_file || server.keyFile || '',
      password: server.pass || ''
    };
  }

  private async _detectRemoteOsPrompt(
    workingDir: { serverName: string; path: string; server: Record<string, string> | null }
  ): Promise<string> {
    const serverName = workingDir.serverName;
    const server = workingDir.server;
    if (!server) {
      logger.log(`No SSH server configuration found for '${serverName}'.`);
      return `remote server '${serverName}' (OS unknown)`;
    }

    try {
      // Reuse the cached connection from remote.ts: it owns the lifecycle of
      // the client, so it must NOT be closed here.
      const target = this._toSshTarget(serverName, server);
      const conn = await getSshConn(buildSshCacheKey(target), buildSshConnectConfig(target));

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
    }
  }


  /** Convenience accessor for `local.projectPrompts`. */
  get projectPrompts(): Array<{ name: string; content: string }> {
    return this.local.projectPrompts;
  }

  /**
   * Load all Markdown prompt files found in the `.axle` folder of the given
   * working directory into `projectPrompts`. Mirrors `buildOsPrompt`: it works
   * for both local and remote (SSH) working directories.
   */
  async buildDirPrompt(workingDir: WorkingDir): Promise<void> {
    this.local.projectPrompts = [];

    try {
      if (!workingDir || workingDir.kind === 'local') {
        const baseDir = workingDir && workingDir.path ? workingDir.path : process.cwd();
        this.local.projectPrompts = this._readLocalProjectPrompts(path.join(baseDir, '.axle'));
      } else {
        this.local.projectPrompts = await this._readRemoteProjectPrompts(workingDir);
      }
    } catch (e: any) {
      logger.log(`Error loading project prompts: ${e}`);
      this.local.projectPrompts = [];
    }

    logger.log(`Loaded ${this.local.projectPrompts.length} project prompt(s).`);
  }

  /**
   * Read `*.md` files from a local `.axle` directory.
   */
  private _readLocalProjectPrompts(axleDir: string): Array<{ name: string; content: string }> {
    const prompts: Array<{ name: string; content: string }> = [];

    if (!fs.existsSync(axleDir) || !fs.statSync(axleDir).isDirectory()) {
      logger.log(`Project prompt folder '${axleDir}' not found.`);
      return prompts;
    }

    const entries = fs.readdirSync(axleDir).sort();
    for (const entry of entries) {
      if (path.extname(entry).toLowerCase() !== '.md') {
        continue;
      }
      const fullPath = path.join(axleDir, entry);
      if (!fs.statSync(fullPath).isFile()) {
        continue;
      }
      try {
        prompts.push({ name: entry, content: fs.readFileSync(fullPath, 'utf8') });
      } catch (e: any) {
        logger.log(`Error reading project prompt '${fullPath}': ${e}`);
      }
    }

    return prompts;
  }

  /**
   * Read `*.md` files from the `.axle` directory of a remote working directory
   * over SSH, reusing the shared connection helpers.
   */
  private async _readRemoteProjectPrompts(
    workingDir: { serverName: string; path: string; server: Record<string, string> | null }
  ): Promise<Array<{ name: string; content: string }>> {
    const prompts: Array<{ name: string; content: string }> = [];
    const serverName = workingDir.serverName;
    const server = workingDir.server;

    if (!server) {
      logger.log(`No SSH server configuration found for '${serverName}'.`);
      return prompts;
    }

    const baseDir = (workingDir.path || '.').replace(/\/+$/, '');
    const axleDir = `${baseDir}/.axle`;
    const delimiter = '<<<AXLE_PROJECT_PROMPT>>>';

    try {
      // Reuse the cached connection from remote.ts: it owns the lifecycle of
      // the client, so it must NOT be closed here.
      const target = this._toSshTarget(serverName, server);
      const conn = await getSshConn(buildSshCacheKey(target), buildSshConnectConfig(target));

      const axleDirQuoted = shellQuote(axleDir);
      const script =
        `if [ -d ${axleDirQuoted} ]; then ` +
        `for f in ${axleDirQuoted}/*.md; do ` +
        `[ -f "$f" ] || continue; ` +
        `echo "${delimiter}$(basename "$f")"; ` +
        `cat "$f"; ` +
        `echo ""; ` +
        `done; ` +
        `fi`;

      const out = await execCommand(conn, script);
      if (out.code !== 0) {
        logger.log(`Failed to list remote project prompts in '${axleDir}' (exit code ${out.code}).`);
        return prompts;
      }

      const chunks = out.stdout.split(delimiter);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        const nl = chunk.indexOf('\n');
        if (nl === -1) {
          continue;
        }
        const name = chunk.substring(0, nl).trim();
        let content = chunk.substring(nl + 1);
        // Drop the single trailing newline added by the shell script.
        if (content.endsWith('\n')) {
          content = content.slice(0, -1);
        }
        if (name) {
          prompts.push({ name, content });
        }
      }
    } catch (e: any) {
      logger.log(`Failed to read project prompts on remote server '${serverName}': ${e}`);
      return prompts;
    }

    return prompts;
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

    // Append the project prompts loaded from `<workingDir>/.axle/*.md` (see
    // buildDirPrompt) so they land at the END of the system prompt.
    if (this.local.projectPrompts.length > 0) {
      parts.push("\n---\n" + "## Project Prompts\n");
      for (const projectPrompt of this.local.projectPrompts) {
        parts.push(`\n### ${projectPrompt.name}\n\n${projectPrompt.content}\n`);
      }
      logger.log(`Appended ${this.local.projectPrompts.length} project prompt(s) to the system prompt.`);
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
