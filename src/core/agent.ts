import { Conduit } from './conduit';
import { Model, ConversationMessage } from './model';
import { ExecutionResponse, discoverExecutors, validate, ExecutorMap, parseActionJson, extractJson } from './executor';
import { TextType } from './parser';
import {logger} from './logger';
import { ModelConfig } from './config';

export class AxleAgent {
  modelName: string;
  skillsFolder: string;
  model: Model;
  executors: Promise<ExecutorMap>;
  conversationHistory: ConversationMessage[] = [];
  baseDir: string;
  conduit: Conduit;
  /** Set to true to request the running continuous task loop to stop. */
  private _stopRequested = false;

  constructor(
    modelConfig: ModelConfig,
    conduit: Conduit
  ) {
    this.modelName = modelConfig.model;
    this.skillsFolder = modelConfig.skillsFolder ?? "skills";
    this.model = new Model(
      modelConfig.key,
      modelConfig.url,
      modelConfig.model,
      this.skillsFolder,
      undefined,
      undefined,
      modelConfig.responses ?? false,
    );

    logger.log(`starting ${this.modelName}`);
    this.executors = discoverExecutors(this.skillsFolder);
    this.conversationHistory = [];
    this.baseDir = modelConfig.workingDir ?? process.cwd();
    this.conduit = conduit;
  }

  cd(dir: string): void {
    this.baseDir = dir;
    this.conduit.send(`Working directory changed to: ${this.baseDir}`);
  }

  getCwd(): string{
    return this.baseDir;
  }

  /**
   * Request the currently running continuous task loop to stop. This only
   * raises a flag; the talk() loop checks it at each iteration and breaks
   * cleanly at the next safe point. Safe to call at any time (also when the
   * agent is idle, in which case it is a no-op until the next talk()).
   */
  requestStop(): void {
    this._stopRequested = true;
    logger.log(`Stop requested for ${this.modelName}`);
  }

  /** Alias for requestStop(), used by the IPC layer. */
  stop(): void {
    this.requestStop();
  }

  /** Whether a stop has been requested for the current/last task loop. */
  isStopping(): boolean {
    return this._stopRequested;
  }

  reload(): void {
    this.model.reloadSkills();
    this.conversationHistory = [];
    this.conduit.send('\nSkills reloaded and conversation reset.\n');
  }

  clear(): void {
    this.conversationHistory = [];
    this.model.clear();
    this.conduit.send('\nConversation history cleared.\n');
  }

  getSkills(): string {
    const skills = this.model.getSkillsSummary();
    this.conduit.send(skills);
    return skills;
  }

  async talk(userInput: string): Promise<void> {
    let followup = true;
    logger.log(`To ${this.modelName}: ${userInput}`);
    let attempt = 0;

    // Fresh task loop: clear any previous stop request and tell the UI the
    // continuous loop is now running (this enables the Stop button).
    this._stopRequested = false;
    this.conduit.send('running', 'stop-state');

    while (followup) {
      // Break out cleanly if a stop was requested (e.g. via the Stop button).
      if (this._stopRequested) {
        logger.log(`Task loop stopped by user request for ${this.modelName}`);
        this.conduit.send('The task was stopped by user request.', 'md');
        break;
      }

      // Get response from agent
      const response = await this.model.chat(userInput, this.conversationHistory);

      logger.log(`${this.modelName} Response: \n${response}`);
      const [textType, payload, text] = validate(response);
      logger.log(`Response format: ${textType}`);

      let result: ExecutionResponse | string | null = null;
      if (textType === TextType.TRUNCATED_JSON) {
        logger.log(`JSON response is truncated. attempt = ${attempt}`)
        if (attempt < 3) {
          const retryPrompt = 'The previous response is truncated, please regenerate the response and consider seperate the response into smaller pieces.';
          result = new ExecutionResponse('', retryPrompt, true, false);
          attempt += 1;
        } else {
          result = new ExecutionResponse('Unrecognized response', '', false, true);
        }
      } else if (textType === TextType.MALFORMATED_JSON) {
        logger.log(`JSON response format is incorrect. attempt = ${attempt}`)
        if (attempt < 3) {
          const retryPrompt = 'The JSON format of the previous response is incorrect, please correct the JSON format and regenerate the response.';
          result = new ExecutionResponse('', retryPrompt, true, false);
          attempt += 1;
        } else {
          result = new ExecutionResponse('Unrecognized response', '', false, true);
        }
      } else if (textType === TextType.JSON || textType == TextType.TRAILING_JSON) {
        result = await this.execute(payload) as ExecutionResponse | string;
        if (text) {
          this.conduit.send(`${text}`, 'md');
        }
      } else {
        result = new ExecutionResponse(response, '', false, true, 'md');
      }

      if (ExecutionResponse.isExecutionResponse(result)) {
        logger.log(`continue: ${result.sequential}`);
        const needPrint = result.print;
        if (needPrint && needPrint === true) {
          this.conduit.send(`${result.content}`, result.format);
        }

        followup = result.sequential;
        if (followup) {
          const nextPrompt = result.prompt;
          userInput = nextPrompt + '\n' + result.content;
          logger.log(`Auto prompt: ${userInput}`);
          this.conduit.send(userInput, 'md');
        } else {
          logger.log(`Result:\n${result.content}`);
        }
      } else {
        followup = false;
        if (result) {
          const rsl = JSON.stringify(result)
          logger.log(`Execution result: ${rsl}`);
          this.conduit.send(rsl, 'md');
        } else {
          logger.log('Empty result');
          this.conduit.send('No response');
        }
      }

      // Update conversation history
      this.conversationHistory.push({ role: 'user', content: userInput });
      this.conversationHistory.push({ role: 'assistant', content: response });
    }

    // Only announce completion when the loop actually finished on its own.
    if (!this._stopRequested) {
      logger.log('The requested task is completed.');
      this.conduit.send('The requested task is completed.');
    }
    // Reset the stop flag and tell the UI the loop is no longer running
    // (this disables the Stop button).
    this._stopRequested = false;
    this.conduit.send('idle', 'stop-state');
    userInput = '';
    followup = true;
  }

  async execute(
    jsonPayload: string,
  ): Promise<ExecutionResponse | null> {
    const executors = await this.executors;
    const actionJson = parseActionJson(jsonPayload);
    const action = actionJson?.action;
    const reasoning = actionJson?.thinking;
    if (reasoning) {
      this.conduit.send(reasoning, "reasoning");
    }
    if (action in executors) {
      logger.log(`find executor for action ${action}`)
      this.conduit.send(`Executing ${action}...`);
      const executor = executors[action];
      const response: ExecutionResponse = await executor(jsonPayload, this.baseDir)
      return response;
    } else {
      logger.log('no action is defined');
      const data = extractJson(jsonPayload);
      if (data) {
        const props: Record<string, any> = {};
        for (const p of data.properties || []) {
          props[p.name] = p.value;
        }
        let content = '';
        for (const k in props) {
          content += props[k] + '\n';
        }
        let toPrint = false;
        if (Object.keys(props).length > 0) {
          toPrint = true;
        }
        return new ExecutionResponse(content, '', false, toPrint, "md");
      } else {
        return new ExecutionResponse('', '', false, true);
      }
    }
  }
}
