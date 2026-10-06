import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import OpenAI from 'openai';
import { app } from 'electron';
import {logger} from './logger'

export interface ConversationMessage {
  role: string;
  content: string;
}

export class Model {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  skillsFolder: string;
  maxTokens: number;
  responses: boolean;
  previousRespId: string | null = null;
  skillsContent: Record<string, string> = {};
  systemPrompt: string = '';
  responsesClient?: OpenAI;

  constructor(
    apiKey: string,
    baseUrl: string = 'https://api.openai.com/v1',
    modelName: string = 'gpt-3.5-turbo',
    skillsFolder: string = 'skills',
    temperature: number = 0.7,
    maxTokens: number = 131072,
    responses: boolean = false,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.modelName = modelName;
    this.maxTokens = maxTokens;
    this.responses = responses;
    this.previousRespId = null;

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
    this.systemPrompt = this._buildSystemPrompt();
    logger.log(`Using ${this.responses ? 'responses' : "completions"} API`);

    this.responsesClient = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
    });
}

  private _loadSkills(): void {
    this.skillsContent = {};

    if (!fs.existsSync(this.skillsFolder) || !fs.statSync(this.skillsFolder).isDirectory()) {
      logger.log(`Skills folder '${this.skillsFolder}' not found.`);
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

      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile()) {
        try {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          this.skillsContent[entry] = content;
        } catch (e: any) {
          logger.log(`Error loading skill '${entry}': ${e}`);
        }
      }
    }

    logger.log(`Loaded ${Object.keys(this.skillsContent).length} skill(s) from '${this.skillsFolder}/'`);
  }

  private _buildSystemPrompt(): string {
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

    const osVersion = `${os.type()} ${os.release()}`;
    logger.log(`OS: ${osVersion}`);
    parts.push(`The current operating system is ${osVersion}. You should provide operating system specific commands and analysis for operating system related tasks.\n`);

    if (Object.keys(this.skillsContent).length > 0) {
      for (const skillName of Object.keys(this.skillsContent)) {
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
        logger.log(`️Error loading SYSTEM.md: ${e}`);
      }
    }

    return parts.join('');
  }

  reloadSkills(): void {
    logger.log('\nReloading skills...');
    this._loadSkills();
    this.systemPrompt = this._buildSystemPrompt();
    logger.log('Skills reloaded successfully.');
  }

  getSkillsSummary(): string {
    if (Object.keys(this.skillsContent).length === 0) {
      return 'No skills loaded.';
    }

    const lines: string[] = ['Loaded Skills:'];
    lines.push('-'.repeat(40));
    let i = 1;
    for (const skillName of Object.keys(this.skillsContent)) {
      lines.push(`  ${i}. ${skillName}`);
      i++;
    }
    lines.push('-'.repeat(40));
    lines.push(`Total: ${Object.keys(this.skillsContent).length} skill(s)`);
    return lines.join('\n');
  }

  async chat(userMessage: string, conversationHistory?: ConversationMessage[]): Promise<string> {
    const messages: any[] = [{ role: 'system', content: this.systemPrompt }];

    if (conversationHistory) {
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    messages.push({ role: 'user', content: userMessage });

    let retry = 1;
    while (true) {
      if (retry > 1) {
        logger.log('Retrying...');
      }
      try {
        if (this.responses) {
          return await this._callLlmResponsesApi(userMessage);
        } else {
          return await this._callLlm(messages);
        }
      } catch (e: any) {
        logger.log(`Communication error: ${String(e)}`);
        retry++;
        if (retry > 3) {
          return `Error communicating with LLM: ${String(e)}`;
        }
      }
    }
  }

  private async _callLlm(messages: any[]): Promise<string> {

    const response = await this.responsesClient?.chat.completions.create({
      model: this.modelName,
      messages
    });


    if (response?.choices && response?.choices.length > 0) {
      const choice = response?.choices[0];
      if (choice.message && choice.message.content) {
        return choice.message.content;
      }
    }

    throw new Error(`Unexpected API response format: ${JSON.stringify(response)}`);
  }

  private async _callLlmResponsesApi(messages: string): Promise<string> {
    const tools = [
      {
        type: 'call',
        action: 'action_name, please generate the action STRICTLY following the name inthe skills',
        thinking: 'the think trace of LLM',
        sequential: {
          prompt: 'prompt used as input for all of following tasks, NOT JUST next task, so that all of the following tasks are not missed.'
        },
        properties: [
          { name: 'property1', value: 'value1' },
          { name: 'property2', value: 'value2' }
        ]
      }
    ];

    const kwargs: any = {
      model: this.modelName,
      instructions: this.systemPrompt,
      input: messages,
      tools,
    };
    if (this.previousRespId) {
      logger.log(`Previous response id: ${this.previousRespId}`);
      kwargs['previous_response_id'] = this.previousRespId;
    } else {
      logger.log('Previous response id is empty');
    }

    const response = await this.responsesClient!.responses.create(kwargs);
    this.previousRespId = response.id;

    return response.output_text;
  }

  clear(): void {
    logger.log(`Clearing response id of ${this.modelName}`)
    this.previousRespId = null;
  }
}
