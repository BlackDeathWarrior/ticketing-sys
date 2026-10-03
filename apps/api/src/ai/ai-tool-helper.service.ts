import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  type CustomToolDraft,
  customToolDraftSchema,
  type CustomToolHelperInput,
  type McpServerDraft,
  mcpServerDraftSchema,
  type McpServerHelperInput,
  type ToolHelperAnswer,
  type ToolHelperTurn,
} from '@tms/shared';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LlmClientService } from '../llm/llm-client.service';
import { ToolsService } from '../tools/tools.service';
import { extractJson } from './json';
import { leaksInternals } from './policy';
import { customToolHelperPrompt, mcpServerHelperPrompt } from './prompts';

const NOT_UNDERSTOOD =
  'I could not work that out. Please describe it again in other words: what should be looked up or changed, and in which system.';

/**
 * The AI helper in Settings → Tools (ADR 0036, the `copilot` role): turns a
 * person's description into the fields of the custom tool or MCP server form.
 * Nothing is stored and nothing is created: what comes back fills a form that
 * the person checks and saves through the usual routes, with their checks.
 */
@Injectable()
export class AiToolHelperService {
  private readonly logger = new Logger(AiToolHelperService.name);

  constructor(
    private readonly llm: LlmClientService,
    private readonly tools: ToolsService,
  ) {}

  async customTool(input: CustomToolHelperInput): Promise<ToolHelperAnswer<CustomToolDraft>> {
    const taken = (await this.tools.listCustom()).map((t) => t.name);
    const said = await this.ask(customToolHelperPrompt({ taken }), input.messages, input.draft);
    const draft = customToolDraftSchema.parse(said.fields);
    const missing = [...said.missing];
    // A name that exists would be refused at saving; say so now instead.
    if (draft.name && taken.includes(draft.name)) {
      delete draft.name;
      missing.push(
        'Choose another name for the AI: a tool with the suggested name already exists.',
      );
    }
    return { message: said.message, draft, missing, model: said.model };
  }

  async mcpServer(input: McpServerHelperInput): Promise<ToolHelperAnswer<McpServerDraft>> {
    const said = await this.ask(mcpServerHelperPrompt(), input.messages, input.draft);
    return {
      message: said.message,
      draft: mcpServerDraftSchema.parse(said.fields),
      missing: said.missing,
      model: said.model,
    };
  }

  private async ask(system: string, turns: ToolHelperTurn[], draft: object | undefined) {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      ...turns.map((t): ChatCompletionMessageParam =>
        t.from === 'you'
          ? { role: 'user', content: `<description>\n${t.text}\n</description>` }
          : { role: 'assistant', content: t.text },
      ),
      {
        role: 'user',
        content: `<form_so_far>\n${JSON.stringify(draft ?? {})}\n</form_so_far>\nAnswer with the JSON object.`,
      },
    ];
    let raw: string;
    let model: string;
    try {
      const r = await this.llm.chat({
        role: 'copilot',
        messages,
        responseFormat: { type: 'json_object' },
        // Room for a model that reasons before it answers.
        maxTokens: 2000,
        temperature: 0.2,
      });
      raw = r.completion.choices[0]?.message.content ?? '';
      model = r.model;
    } catch (err) {
      this.logger.warn(`tool helper: ${(err as Error).message.slice(0, 200)}`);
      throw new ServiceUnavailableException(
        'The AI helper is not available right now. You can still fill in the form yourself.',
      );
    }
    const said = (extractJson(raw) ?? {}) as {
      message?: unknown;
      fields?: unknown;
      missing?: unknown;
    };
    const text = typeof said.message === 'string' ? said.message.trim().slice(0, 1200) : '';
    return {
      // A reply that carries something shaped like a key is not passed on.
      message: text && !leaksInternals(text) ? text : NOT_UNDERSTOOD,
      fields: said.fields && typeof said.fields === 'object' ? said.fields : {},
      missing: Array.isArray(said.missing)
        ? said.missing
            .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
            .slice(0, 8)
            .map((m) => m.trim().slice(0, 240))
        : [],
      model,
    };
  }
}
