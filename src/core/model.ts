import OpenAI from 'openai';
import { app } from 'electron';
import { logger } from './logger';
import { AxlePrompt } from './prompt';

export interface ConversationMessage {
  role: string;
  content: string;
}

export class Model {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  prompt: AxlePrompt;
  maxTokens: number;
  responses: boolean;
  previousRespId: string | null = null;
  responsesClient?: OpenAI;

  constructor(
    apiKey: string,
    baseUrl: string = 'https://api.openai.com/v1',
    modelName: string = 'gpt-3.5-turbo',
    prompt: AxlePrompt,
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

    this.prompt = prompt;
    logger.log(`Using ${this.responses ? 'responses' : "completions"} API`);

    this.responsesClient = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
    });
  }

  /**
   * The cached system prompt assembled by the AxlePrompt instance. The
   * AxlePrompt holds the skills map and rebuilds the prompt only when skills
   * are (re)loaded.
   */
  get systemPrompt(): string {
    return this.prompt.getSystemPrompt();
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
