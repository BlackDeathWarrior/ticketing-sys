import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  type ConnectionDiagnosis,
  type CustomToolDraft,
  customToolDraftSchema,
  type CustomToolHelperInput,
  type DiagnoseConnectionInput,
  type McpServerDraft,
  mcpServerDraftSchema,
  type McpServerHelperInput,
  TOOL_PROBLEM_TAG,
  TOOL_PROBLEM_TICKET_KIND,
  type ToolHelperAnswer,
  type ToolHelperTurn,
} from '@tms/shared';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { InboundService } from '../channels/inbound.service';
import type { RequestCtx } from '../common/request-context';
import { LlmClientService } from '../llm/llm-client.service';
import { ToolsService } from '../tools/tools.service';
import { extractJson } from './json';
import { leaksInternals } from './policy';
import {
  connectionDiagnosisPrompt,
  customToolHelperPrompt,
  mcpServerHelperPrompt,
} from './prompts';

/** How many company systems the helper is told about; a desk talks to a handful at most. */
const MAX_SYSTEMS = 3;

/** `https://shop.example.com` of an address that may hold `{placeholders}`, or null. */
function originOf(url: string): string | null {
  try {
    return new URL(url.replace(/\{[^{}]*\}/g, 'x')).origin;
  } catch {
    return null;
  }
}

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
    private readonly inbound: InboundService,
  ) {}

  async customTool(input: CustomToolHelperInput): Promise<ToolHelperAnswer<CustomToolDraft>> {
    const taken = (await this.tools.listCustom()).map((t) => t.name);
    // What the desk can find out by itself, so the person is not asked for it: the systems
    // the tools already call, their conventions, and what each says it can do.
    const systems = (await this.tools.knownSystems()).slice(0, MAX_SYSTEMS);
    const catalogues = await Promise.all(systems.map((s) => this.tools.catalogue(s)));
    const said = await this.ask(
      customToolHelperPrompt({
        taken,
        systems: systems.map((s, i) => ({
          base: s.base,
          keyHeader: s.keyHeader,
          customerParameter: s.customerParameter,
          existingTools: s.tools,
          operations: catalogues[i],
        })),
      }),
      input.messages,
      input.draft,
    );
    const draft = customToolDraftSchema.parse(said.fields);
    const missing = [...said.missing];
    // A name that exists would be refused at saving. With a free one at hand the
    // person is not asked: they did not choose the first one either.
    if (draft.name && taken.includes(draft.name)) {
      const base = draft.name.slice(0, 37);
      const free = [2, 3, 4, 5, 6, 7, 8, 9]
        .map((n) => `${base}_${n}`)
        .find((n) => !taken.includes(n));
      if (free) draft.name = free;
      else delete draft.name;
    }

    // A tool for a system the desk already talks to follows that system's ways, whatever the
    // model left out, and can use the key that is already saved for it.
    const system = draft.url ? systems.find((s) => originOf(draft.url!) === s.origin) : undefined;
    if (system && draft.authHeader === undefined) draft.authHeader = system.keyHeader;
    const keyFrom =
      system?.keyed && draft.authHeader
        ? { toolId: system.keyed.id, title: system.keyed.title }
        : null;
    return { message: said.message, draft, missing, keyFrom, model: said.model };
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

  /**
   * Explains a failed connection check in plain words and saves it as a bug: a
   * ticket a person can pick up, tagged `tool-bug`. The same address goes to
   * the same ticket while it is open, so repeated tries add to it. The failure
   * is saved even when no model is available to explain it.
   */
  async diagnose(
    ctx: RequestCtx,
    kind: 'custom_tool' | 'mcp_server',
    input: DiagnoseConnectionInput,
  ): Promise<ConnectionDiagnosis> {
    const what = kind === 'mcp_server' ? 'MCP server' : 'custom tool';
    const tried = {
      what,
      name: input.name || null,
      address: `${input.method ? `${input.method} ` : ''}${input.url}`,
      answerCode: input.check.status,
      result: input.check.summary,
      detail: input.check.detail,
    };
    let cause = input.check.summary;
    let steps: string[] = [];
    let model: string | null = null;
    try {
      const r = await this.llm.chat({
        role: 'copilot',
        messages: [
          { role: 'system', content: connectionDiagnosisPrompt(kind) },
          { role: 'user', content: `<check>\n${JSON.stringify(tried)}\n</check>` },
        ],
        responseFormat: { type: 'json_object' },
        // Room for a model that reasons before it answers.
        maxTokens: 1500,
        temperature: 0.2,
      });
      const said = (extractJson(r.completion.choices[0]?.message.content ?? '') ?? {}) as {
        cause?: unknown;
        steps?: unknown;
      };
      const text = typeof said.cause === 'string' ? said.cause.trim().slice(0, 800) : '';
      if (text && !leaksInternals(text)) cause = text;
      if (Array.isArray(said.steps)) {
        steps = said.steps
          .filter(
            (s): s is string => typeof s === 'string' && s.trim() !== '' && !leaksInternals(s),
          )
          .slice(0, 5)
          .map((s) => s.trim().slice(0, 300));
      }
      model = r.model;
    } catch (err) {
      // Without a model the failure is still worth a ticket; the check's own words stand in.
      this.logger.warn(`connection diagnosis: ${(err as Error).message.slice(0, 200)}`);
    }

    const label = input.name || input.url;
    const lines = [
      `A connection check failed for the ${what} "${label}".`,
      '',
      `Address: ${tried.address}`,
      `What came back: ${input.check.status ?? 'no answer'}. ${input.check.summary}`,
      ...(input.check.detail ? [`Detail: ${input.check.detail}`] : []),
      '',
      `Likely cause${model ? ' (worked out by the AI helper)' : ''}: ${cause}`,
      ...(steps.length ? ['What to try:', ...steps.map((s) => `- ${s}`)] : []),
      '',
      `Checked by ${ctx.user?.name ?? 'a colleague'} in Settings, Tools.`,
    ];
    let bug: ConnectionDiagnosis['bug'] = null;
    try {
      const saved = await this.inbound.handle({
        channel: 'agent',
        // The address is the thread: another failed try joins the ticket while it is open.
        threadKey: `tool-problem:${kind}:${createHash('sha256').update(input.url).digest('hex').slice(0, 32)}`,
        channelMessageId: `tool-problem:${randomUUID()}`,
        from: {
          identity: { type: 'external_id', value: 'desk:tool-checks' },
          displayName: 'Tool checks (automatic reports)',
        },
        subject: `Tool problem: ${label}`.slice(0, 300),
        text: lines.join('\n'),
        receivedAt: new Date().toISOString(),
        metadata: { via: 'tool-helper', reportedBy: ctx.user?.id ?? null },
        ticket: {
          tags: [TOOL_PROBLEM_TAG],
          metadata: { kind: TOOL_PROBLEM_TICKET_KIND, what, address: tried.address },
        },
        // A person fixes a connection; there is no customer to answer.
        ai: 'off',
      });
      if (saved.ticketReference) {
        bug = { reference: saved.ticketReference, created: saved.createdTicket };
      }
    } catch (err) {
      this.logger.error(`connection diagnosis: the bug was not saved: ${(err as Error).message}`);
    }
    return { cause, steps, bug, model };
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
