import OpenAI from 'openai';
import { logger } from './logger';
import { AxlePrompt } from './prompt';

export interface Attachment {
  /** Image format, e.g. 'jpeg', 'png', 'webp'. */
  format: string;
  /** Base64-encoded image content (without the `data:` prefix). */
  content: string;
}

export interface ChatInput {
  userinput: string;
  attachments?: Attachment[];
}

/** Content of a conversation message: a plain string or a multimodal parts array. */
export type MessageContent = string | any[];

export interface ConversationMessage {
  role: string;
  content: MessageContent;
}

/**
 * Hard limit on the number of image attachments forwarded to the model. Only
 * the first MAX_ATTACHMENTS are kept; the UI enforces the same limit.
 */
export const MAX_ATTACHMENTS = 5;

/**
 * Build a `data:image/<format>;base64,<content>` URL from a base64 attachment.
 */
export function toDataUrl(attachment: Attachment): string {
  const format = attachment.format || 'png';
  return `data:image/${format};base64,${attachment.content}`;
}

/**
 * Keep only the first MAX_ATTACHMENTS non-empty attachments from a list.
 * Returns an empty array when nothing usable is provided.
 */
export function limitAttachments(attachments?: Attachment[]): Attachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  return attachments.filter((a) => a && a.content).slice(0, MAX_ATTACHMENTS);
}

/**
 * Build the user message content for the completion API, embedding EVERY
 * attachment (capped at MAX_ATTACHMENTS) as an `image_url` part. Falls back to
 * the plain text string when there is no attachment, preserving legacy behavior.
 */
export function buildUserContent(text: string, attachments?: Attachment[]): MessageContent {
  const limited = limitAttachments(attachments);
  if (limited.length === 0) {
    return text;
  }
  return [
    { type: 'text', text },
    ...limited.map((a) => ({ type: 'image_url', image_url: { url: toDataUrl(a) } })),
  ];
}

/**
 * Build the `input` payload for the responses API. When attachments are present
 * this returns a single user message whose content parts contain an `input_text`
 * part and one `input_image` part per attachment (capped at MAX_ATTACHMENTS);
 * otherwise it returns the plain text string, preserving legacy behavior.
 */
export function buildResponsesInput(text: string, attachments?: Attachment[]): any {
  const limited = limitAttachments(attachments);
  if (limited.length === 0) {
    return text;
  }
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...limited.map((a) => ({ type: 'input_image', image_url: toDataUrl(a) })),
      ],
    },
  ];
}

/**
 * The uniform result of ONE chat turn, shared by BOTH APIs. `text` is the
 * model's textual output; `binary` is a raw base64 image (no `data:` prefix)
 * emitted by the responses API when the model returns an image, and is always
 * null for the completion API (which only ever produces text).
 */
export interface ChatResult {
  text: string;
  binary: string | null;
}

/**
 * Strip a leading `data:image/<type>;base64,` prefix from a value, returning
 * raw base64. Values that are already raw base64 are returned unchanged.
 */
export function stripDataUrl(value: string): string {
  if (!value) return value;
  const marker = ';base64,';
  const idx = value.indexOf(marker);
  if (value.startsWith('data:') && idx >= 0) {
    return value.slice(idx + marker.length);
  }
  return value;
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
  /**
   * Per-model conversation history, owned by the Model itself. It is used ONLY
   * to build the completion-API message list ({@link chat}); the responses API
   * keeps its own server-side history via {@link previousRespId}. The list is
   * reset by {@link resetConversation} / {@link clear}.
   */
  conversationHistory: ConversationMessage[] = [];

  constructor(
    apiKey: string,
    baseUrl: string = 'https://api.openai.com/v1',
    modelName: string = 'gpt-3.5-turbo',
    prompt: AxlePrompt,
    temperature: number = 0.7,
    maxTokens: number = 131072,
    responses: boolean = false
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

  async chat(input: ChatInput | string): Promise<ChatResult> {
    const userMessage: string = typeof input === 'string' ? input : input.userinput;
    const attachments: Attachment[] | undefined = typeof input === 'string' ? undefined : input.attachments;

    const messages: any[] = [{ role: 'system', content: this.systemPrompt }];

    // Completion-API history: the stored per-model history is replayed ahead of
    // the new user message. The message structure is unchanged from before.
    for (const msg of this.conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    messages.push({ role: 'user', content: buildUserContent(userMessage, attachments) });

    let retry = 1;
    while (true) {
      if (retry > 1) {
        logger.log('Retrying...');
      }
      try {
        if (this.responses) {
          // Responses API keeps its own server-side history (previousRespId),
          // so no local history is recorded or emitted for it.
          return await this._callLlmResponsesApi(userMessage, attachments);
        } else {
          const result = await this._callLlm(messages);
          // Completion API only: record this turn and immediately emit the
          // updated conversation history.
          this.recordTurn(userMessage, attachments, result.text);
          return result;
        }
      } catch (e: any) {
        logger.log(`Communication error: ${String(e)}`);
        retry++;
        if (retry > 3) {
          const errText = `Error communicating with LLM: ${String(e)}`;
          // Keep the completion history consistent with what was sent, even on
          // a terminal failure.
          if (!this.responses) {
            this.recordTurn(userMessage, attachments, errText);
          }
          return { text: errText, binary: null };
        }
      }
    }
  }

  private async _callLlm(messages: any[]): Promise<ChatResult> {

    const response = await this.responsesClient?.chat.completions.create({
      model: this.modelName,
      messages
    });


    if (response?.choices && response?.choices.length > 0) {
      const choice = response?.choices[0];
      if (choice.message && choice.message.content) {
        // The completion API only ever returns text; binary is always null.
        return { text: choice.message.content, binary: null };
      }
    }

    throw new Error(`Unexpected API response format: ${JSON.stringify(response)}`);
  }

  private async _callLlmResponsesApi(userMessage: string, attachments?: Attachment[]): Promise<ChatResult> {
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
      input: buildResponsesInput(userMessage, attachments),
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

    // Both APIs return the SAME shape. The responses API may additionally
    // yield an image (e.g. image_generation_call); extract it into `binary`.
    return {
      text: this.extractResponsesText(response),
      binary: this.extractResponsesImage(response),
    };
  }

  /**
   * Extract the textual output from a responses-API result. Prefers the
   * convenience `output_text`, falling back to concatenating any
   * `output_text` / `text` content parts across the `output` array.
   */
  private extractResponsesText(resp: any): string {
    if (resp && typeof resp.output_text === 'string' && resp.output_text.length > 0) {
      return resp.output_text;
    }
    let text = '';
    for (const item of (resp?.output ?? [])) {
      const parts = item?.content ?? [];
      for (const part of parts) {
        if (typeof part?.text === 'string') {
          text += part.text;
        } else if (typeof part?.output_text === 'string') {
          text += part.output_text;
        }
      }
    }
    return text;
  }

  /**
   * Extract an image (raw base64, no `data:` prefix) from a responses-API
   * result, or null when no image is present. Handles both
   * `image_generation_call` items (whose payload is in `result`) and image
   * content parts (b64 / data / result, or an `image_url.url` data URL).
   */
  private extractResponsesImage(resp: any): string | null {
    for (const item of (resp?.output ?? [])) {
      if (item?.type === 'image_generation_call' && typeof item.result === 'string') {
        return stripDataUrl(item.result);
      }
      for (const part of (item?.content ?? [])) {
        const type = typeof part?.type === 'string' ? part.type : '';
        if (typeof part?.b64 === 'string') return stripDataUrl(part.b64);
        if (typeof part?.data === 'string' && type.includes('image')) return stripDataUrl(part.data);
        if (typeof part?.result === 'string' && type.includes('image')) return stripDataUrl(part.result);
        if (typeof part?.image_url?.url === 'string') return stripDataUrl(part.image_url.url);
        if (type.includes('image') && typeof part?.image_url === 'string') return stripDataUrl(part.image_url);
      }
    }
    return null;
  }

  /**
   * Record ONE completion-API turn (the user message as sent, plus the model's
   * reply) into the per-model history and then emit the updated history. Only
   * used by the completion path; the responses API relies on the server-side
   * {@link previousRespId} instead.
   */
  private recordTurn(userMessage: string, attachments: Attachment[] | undefined, assistantText: string): void {
    this.conversationHistory.push({ role: 'user', content: buildUserContent(userMessage, attachments) });
    this.conversationHistory.push({ role: 'assistant', content: assistantText });
  }

  clear(): void {
    logger.log(`Clearing response id of ${this.modelName}`)
    this.previousRespId = null;
    this.conversationHistory = [];
  }
}
