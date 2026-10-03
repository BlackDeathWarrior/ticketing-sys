import { Injectable, Logger } from '@nestjs/common';
import {
  internationalCallerNumber,
  PHONE_TOOL_RESULT_MAX,
  type PhoneStartInput,
  type PhoneStartReply,
  type PhoneToolEntry,
  type PhoneToolInput,
  type PhoneToolName,
  type PhoneToolReply,
} from '@tms/shared';
import { addressOf } from '../../ai/address';
import { AI_CTX } from '../../common/request-context';
import { CustomersService } from '../../customers/customers.service';
import { KbSearchService } from '../../kb/kb-search.service';
import { BrandingService } from '../../settings/branding.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ToolGatewayService } from '../../tools/tool-gateway.service';
import { type AgentTool, ToolsService } from '../../tools/tools.service';
import { type CallRow, VoiceCallsService } from '../voice/voice-calls.service';
import { PhoneQueryTranslator } from './phone-query-translator.service';

/** Sarvam waits 30 seconds for a tool at most; we answer before that with something to say. */
const TOOL_DEADLINE_MS = 25_000;
const KB_HITS = 3;

const NOT_LINKED =
  "This caller's number is not linked to a shop account. They can add and confirm it under their account on the shop site, then call again.";
const NEEDS_COLLEAGUE =
  'That needs a colleague. Offer the caller a call back and use request_person.';
const TOO_LONG = 'That took too long. Apologise and offer to try once more.';
const WENT_WRONG =
  'Something went wrong on our side. Apologise, and offer to try once more or a call back.';

const ok = (result: string): PhoneToolReply => ({
  ok: true,
  result: result.slice(0, PHONE_TOOL_RESULT_MAX),
});
/**
 * On the third real call the agent got an empty order list and told the caller about an
 * order, an item and a price that do not exist. Every answer now says what it is and that
 * nothing may be added to it: the agent's model is not ours to constrain any other way.
 */
const NEVER_INVENT =
  'Never make up an order, a product, a price, a date or a policy: say only what is written here.';
const FROM_SYSTEM = `Answer from the shop's system. If a list in it is empty or a count is 0, tell the caller that nothing was found. ${NEVER_INVENT}\n`;
const FROM_ARTICLES = `From the shop's help articles. Answer only from this text. ${NEVER_INVENT}\n`;
const fail = (result: string): PhoneToolReply => ({
  ok: false,
  result: `Error: ${result} Tell the caller you could not find or do that. ${NEVER_INVENT}`,
});

/**
 * What the phone agent at Sarvam can ask this desk for during a call
 * (ADR 0039). The desk runs no model here: the agent decides, and every
 * company tool still goes through the gateway, for the customer the caller's
 * proven number belongs to and nobody else.
 */
@Injectable()
export class PhoneToolsService {
  private readonly logger = new Logger(PhoneToolsService.name);

  constructor(
    private readonly tools: ToolsService,
    private readonly gateway: ToolGatewayService,
    private readonly kb: KbSearchService,
    private readonly customers: CustomersService,
    private readonly branding: BrandingService,
    private readonly calls: VoiceCallsService,
    private readonly channels: ChannelConfigService,
    private readonly translator: PhoneQueryTranslator,
  ) {}

  /**
   * Every enabled tool, read now, so one added in Settings is there on the
   * next call. Tools that need an approval are left out until the outcome can
   * reach the caller (a call back).
   */
  async catalogue(): Promise<PhoneToolEntry[]> {
    return (await this.offered()).map((t) => {
      const fn = (t.definition as { function: { description?: string; parameters?: unknown } })
        .function;
      return {
        name: t.qualifiedName,
        description: fn.description ?? t.tool.name,
        parameters: (fn.parameters ?? {}) as Record<string, unknown>,
      };
    });
  }

  /** The call begins: who is calling, and what the agent can use. */
  async start(input: PhoneStartInput): Promise<PhoneStartReply> {
    const caller = await this.caller(input.phone);
    const call = await this.open(input.interactionId, caller);
    const phone = caller ?? call?.callerPhone;
    const owner = phone ? await this.customers.provenPhoneOwner(phone) : null;
    // A caller whose number is registered is greeted by first name, with or without a title
    // on file (the product owner's choice for phone calls); nothing when the name on file
    // is not a person's name (ADR 0037).
    const name = owner ? (addressOf(owner.name, null)?.short ?? '') : '';
    const company = (await this.branding.get()).companyName;
    return {
      customer_name: name,
      greeting: name
        ? `Hello ${name}, thanks for calling ${company}.`
        : `Hello, thanks for calling ${company}.`,
      known: !!owner,
      company,
      desk_tools: JSON.stringify(await this.catalogue()),
    };
  }

  /**
   * Always answers, and in time: whatever goes wrong here, the caller is on
   * the line and the agent needs something to say.
   */
  async run(tool: PhoneToolName, body: PhoneToolInput): Promise<PhoneToolReply> {
    const work = this.answer(tool, body).catch((err: Error) => {
      this.logger.warn(`phone tool ${tool} failed: ${err.message}`);
      return fail(WENT_WRONG);
    });
    return Promise.race([
      work,
      new Promise<PhoneToolReply>((resolve) =>
        setTimeout(() => resolve(fail(TOO_LONG)), TOOL_DEADLINE_MS),
      ),
    ]);
  }

  /** The caller's number in the form proven numbers are stored in (with the country code). */
  private async caller(phone: string | null): Promise<string | null> {
    return internationalCallerNumber(phone, (await this.channels.phone())?.agentPhoneNumber ?? '');
  }

  private async answer(tool: PhoneToolName, input: PhoneToolInput): Promise<PhoneToolReply> {
    const body = { ...input, phone: await this.caller(input.phone) };
    // The start hook may never have arrived: any tool call opens the call's record.
    const call = await this.open(body.interactionId, body.phone);
    switch (tool) {
      case 'list_tools':
        // Not cut short: half a catalogue is not JSON any more.
        return { ok: true, result: JSON.stringify(await this.catalogue()) };
      case 'search_knowledge':
        return this.searchKnowledge(body.query ?? '');
      case 'request_person':
        if (call) {
          await this.calls.markHandover(call.id, body.reason || 'The caller asked for a person');
        }
        return ok(
          'Noted. Tell the caller a colleague will get back to them, then end the call politely.',
        );
      case 'desk_tool':
        return this.deskTool(call, body);
    }
  }

  /**
   * The call's record, opened if this is the first we hear of the call. Null
   * for a request with no call id: a tool tried from Sarvam's dashboard, which
   * gets a real answer and leaves no record.
   */
  private async open(interactionId: string | null, phone: string | null): Promise<CallRow | null> {
    return interactionId ? this.calls.beginPhone({ interactionId, phone }) : null;
  }

  private async offered(): Promise<AgentTool[]> {
    return (await this.tools.agentTools()).filter((t) => t.tool.tier !== 'transactional');
  }

  private async searchKnowledge(query: string): Promise<PhoneToolReply> {
    if (!query) return fail('Give the question to look up in "query".');
    // The knowledge base is in English; the caller may not be.
    const q = await this.translator.toEnglish(query);
    const { hits } = await this.kb.search(
      {},
      { q, limit: KB_HITS, audience: 'customer', includeDrafts: false },
    );
    if (!hits.length) return fail('Nothing in the help articles matches.');
    return ok(
      FROM_ARTICLES +
        hits
          .map((h) => `${h.title}${h.section ? ` › ${h.section}` : ''}: ${h.snippet}`)
          .join('\n\n'),
    );
  }

  private async deskTool(call: CallRow | null, body: PhoneToolInput): Promise<PhoneToolReply> {
    const name = body.name ?? '';
    const all = await this.tools.agentTools();
    const byBareName = all.filter((t) => t.tool.name === name);
    const found =
      all.find((t) => t.qualifiedName === name) ??
      (byBareName.length === 1 ? byBareName[0] : undefined);
    if (!found) {
      const names = (await this.offered()).map((t) => t.qualifiedName).join(', ');
      return fail(`There is no tool called "${name}". The tools are: ${names}.`);
    }
    if (found.tool.tier === 'transactional') return fail(NEEDS_COLLEAGUE);

    // The number this token-protected request carries; the call's record (set only by such
    // requests) when this one has none.
    const phone = body.phone ?? call?.callerPhone;
    const owner = phone ? await this.customers.provenPhoneOwner(phone) : null;
    const run = this.gateway.invoke(AI_CTX, {
      tool: found.tool,
      server: found.server,
      // The shop's catalogue is in English too: a search for "लाल कुर्ता" would find nothing.
      args: await this.translator.argumentsToEnglish(body.arguments?.trim() || '{}'),
      ticketId: null,
      conversationId: null,
      customerEmail: owner?.email ?? null,
    });
    // Kept for the ticket even when the answer comes too late for the caller.
    void run
      .then((r) => (call && r.callId ? this.calls.noteToolCall(call.id, r.callId) : undefined))
      .catch((err: Error) => this.logger.warn(`tool call on a phone call: ${err.message}`));

    const r = await run;
    switch (r.status) {
      case 'ok':
        return ok(
          FROM_SYSTEM + (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? {})),
        );
      case 'denied':
        return fail(found.tool.customerArg && !owner?.email ? NOT_LINKED : r.error);
      case 'error':
        return fail(r.error);
      default:
        return fail(NEEDS_COLLEAGUE);
    }
  }
}
