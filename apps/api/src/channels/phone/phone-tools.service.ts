import { Injectable, Logger } from '@nestjs/common';
import {
  internationalCallerNumber,
  PHONE_TOOL_RESULT_MAX,
  type PhoneProviderId,
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
import { CustomerMail } from '../../settings/customer-mail.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ToolGatewayService } from '../../tools/tool-gateway.service';
import { type AgentTool, modelSchema, ToolsService } from '../../tools/tools.service';
import { type CallRow, VoiceCallsService } from '../voice/voice-calls.service';
import { WhatsAppLinkSender } from '../whatsapp/whatsapp-link.sender';
import { PhoneEmailLink } from './phone-email-link.service';
import { outboundGreeting } from './phone-provider';
import { PhoneQueryTranslator } from './phone-query-translator.service';

/** Sarvam waits 30 seconds for a tool at most; we answer before that with something to say. */
const TOOL_DEADLINE_MS = 25_000;
const KB_HITS = 3;

const NOT_LINKED =
  'This caller’s number is not linked to an account, so this cannot be done yet. Tell them their email address and this phone number have to be linked first, and offer to do it now: ask for the email address of their account, have it spelled out, and use verify_email with it. A code is emailed to them; they read it to you and you give it to confirm_email_code. If they have no account, offer to start one if you have a tool for it. Until then you can help with products and general questions.';
const NEEDS_COLLEAGUE =
  'That needs a colleague. Offer the caller a call back and use request_person.';
const APPROVAL_NEEDED =
  'This needs a colleague’s approval and has been passed on for it. It is NOT done. Tell the caller that a colleague must approve it and that they will be rung back with the answer.\n';
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
const LINK_SENT =
  'The link in this answer was sent just now to the caller’s WhatsApp, on the number they are calling from. Tell them to open WhatsApp for it. Do not read the link out.\n';
const LINK_EMAILED =
  'The link in this answer was sent just now to the caller’s email address. Tell them to look in their email for it. Do not read the link out.\n';
const LINK_NOT_SENT =
  'The link in this answer could NOT be sent to the caller. Never say a link or message was sent. Tell them to open the shop’s website, sign in and go there themselves.\n';
const LINK_REPEAT_MS = 10 * 60_000;
const CONFIRMATION_SENT =
  'A written confirmation of this was sent just now to the caller’s WhatsApp. Tell them so.\n';
const CONFIRMATION_EMAILED =
  'A written confirmation of this was sent just now to the caller’s email address. Tell them so.\n';
const CONFIRMATION_NOT_SENT =
  'No written confirmation could be sent to the caller. Do not say that one was sent.\n';
const CONFIRMATION_MAX = 600;

/**
 * On a call on 2026-10-04 a caller asked for their order's details on WhatsApp and the agent could only
 * say it had no way to send them. This tool is the desk's own, offered in the catalogue next
 * to the company's: it sends what the agent writes to the number the caller has proven.
 */
export const SEND_WHATSAPP = 'send_whatsapp';
const SEND_WHATSAPP_MAX = 1_000;
export const SEND_WHATSAPP_ENTRY: PhoneToolEntry = {
  name: SEND_WHATSAPP,
  description:
    'Sends a written message to the caller: to their WhatsApp, on the number they are calling from, or to their email address when WhatsApp cannot reach them. Use it when the caller asks to get details in writing (an order, a payment, a return, a product). Look the details up with a tool first. Write "message" in the caller’s language, in plain sentences, with only what a tool answered on this call.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: `The text to send, at most ${SEND_WHATSAPP_MAX} characters. No web addresses.`,
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
};
export const VERIFY_EMAIL = 'verify_email';
export const CONFIRM_EMAIL_CODE = 'confirm_email_code';
/** The desk's own tools a phone agent gets beside the company's, in the order they are listed. */
export const OWN_PHONE_TOOLS: PhoneToolEntry[] = [
  SEND_WHATSAPP_ENTRY,
  {
    name: VERIFY_EMAIL,
    description:
      'Starts linking the caller’s phone number to their email address, so that their orders, cart and payments can be looked up on this and later calls. Use it when a tool answers that the caller’s number is not linked. Ask for the email address of their account and have it spelled out. It emails them a six-digit code; then use confirm_email_code.',
    parameters: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'The caller’s email address, in lower case, for example asha@example.com.',
        },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: CONFIRM_EMAIL_CODE,
    description:
      'Finishes linking the caller’s phone number to their email address: give the six-digit code the caller read out from the email that verify_email sent.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The six digits, for example 482913.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
];
const MESSAGE_SENT =
  'The message was sent just now to the caller’s WhatsApp, on the number they are calling from. Tell them to open WhatsApp for it.';
const MESSAGE_EMAILED =
  'The message was sent just now to the caller’s email address. Tell them to look in their email for it.';
const MESSAGE_NOT_SENT =
  'The message could NOT be sent, on WhatsApp or by email. Never say it was sent. Tell the caller to look under their account on the shop’s website.';
/**
 * On two calls after the tool existed, the agent still told the caller it could not send
 * anything to WhatsApp: it had not taken the tool in from its list. So every answer from the
 * shop's system now says, where the agent is reading it, that it can be sent and how.
 */
const CAN_SEND: Record<PhoneProviderId, string> = {
  sarvam:
    'You CAN send this to the caller in writing (WhatsApp, or email). If they ask for it in writing or on WhatsApp, never say you cannot: call desk_tool with name "send_whatsapp" and arguments {"message":"<the details, in the caller’s language>"}.\n',
  elevenlabs:
    'You CAN send this to the caller in writing (WhatsApp, or email). If they ask for it in writing or on WhatsApp, never say you cannot: use the tool send_whatsapp with the details as "message", in the caller’s language.\n',
};
const LOOK_UP_FIRST =
  'Nothing has been looked up on this call yet. Use a tool to get the details first, then send them.';

/**
 * What a company tool wrote for the customer about what it just did
 * (`confirmation` at the top of its result): sent to the caller in writing.
 */
function confirmationIn(result: unknown): string | null {
  const text =
    result && typeof result === 'object' ? (result as Record<string, unknown>).confirmation : null;
  return typeof text === 'string' && text.trim() && text.length <= CONFIRMATION_MAX
    ? text.trim()
    : null;
}

/** A link a tool answered with (`url` at the top of its result): what a caller cannot be read. */
function linkIn(result: unknown): string | null {
  const url = result && typeof result === 'object' ? (result as Record<string, unknown>).url : null;
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) && url.length <= 1000 ? url : null;
}

/**
 * A tool's answer as the agent gets it: without web addresses. On an ElevenLabs call the
 * agent read a product's link out as "[View it here](https://…)": a model that sees an
 * address tends to say it, whatever its instruction says. A link the caller needs goes to
 * their WhatsApp instead (`shareLink`).
 */
function withoutAddresses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAddresses);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => !(typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim())))
        .map(([k, v]) => [k, withoutAddresses(v)]),
    );
  }
  return value;
}

/**
 * The names of the inputs a request carried, never their values: what a refusal is logged
 * with. On a call on 2026-10-04 the cart tool was refused six times and nothing said what
 * the agent had sent.
 */
function inputNames(args: string | undefined): string {
  try {
    const parsed = JSON.parse(args?.trim() || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).join(', ')
      : 'not an object';
  } catch {
    return 'not JSON';
  }
}

/**
 * A tool's inputs, in words: appended to a refusal so the agent's next try is right. Naming
 * them alone was not enough on that call: the agent added an input of its own.
 */
function inputsOf(tool: AgentTool): string {
  const schema = modelSchema(
    tool.tool.inputSchema as Record<string, unknown>,
    tool.tool.customerArg,
  );
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const inputs = Object.entries(schema.properties as Record<string, { type?: unknown }>).map(
    ([name, p]) =>
      `"${name}" (${p.type === 'integer' || p.type === 'number' ? 'a number' : p.type === 'boolean' ? 'true or false' : 'text'}${required.has(name) ? ', needed' : ''})`,
  );
  return inputs.length
    ? ` This tool takes exactly these inputs and no others: ${inputs.join(', ')}.`
    : ' This tool takes no inputs.';
}

/**
 * The agent's arguments without inputs the tool does not have. The agent's model is not
 * ours: on that call it sent the cart tool an "action" beside the right inputs, twice, and
 * the caller got nothing. An input the tool never sees cannot do harm, so it is dropped
 * here, not refused. Anything that is not a JSON object is left for the gateway to refuse.
 */
function fitted(tool: AgentTool, args: string): { args: string; dropped: string[] } {
  const schema = tool.tool.inputSchema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  } | null;
  if (!schema?.properties || schema.additionalProperties !== false) return { args, dropped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { args, dropped: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { args, dropped: [] };
  const known = schema.properties;
  const dropped = Object.keys(parsed).filter((k) => !(k in known));
  if (!dropped.length) return { args, dropped };
  return {
    args: JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([k]) => k in known))),
    dropped,
  };
}

const fail = (result: string): PhoneToolReply => ({
  ok: false,
  result: `Error: ${result} Tell the caller you could not find or do that. ${NEVER_INVENT}`,
});

/**
 * What a phone agent (Sarvam's or ElevenLabs') can ask this desk for during a
 * call (ADR 0039, ADR 0040). The desk runs no model here: the agent decides, and every
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
    private readonly links: WhatsAppLinkSender,
    private readonly mail: CustomerMail,
    private readonly emailLink: PhoneEmailLink,
  ) {}

  /** Links sent on calls in progress, so the same one is not sent twice: key → when. */
  private readonly linksSent = new Map<string, { at: number; by: 'whatsapp' | 'email' }>();

  /**
   * Every enabled tool, read now, so one added in Settings is there on the
   * next call. The desk's own tools come first.
   */
  async catalogue(): Promise<PhoneToolEntry[]> {
    const company = (await this.offered()).map((t) => {
      const fn = (t.definition as { function: { description?: string; parameters?: unknown } })
        .function;
      return {
        name: t.qualifiedName,
        description: fn.description ?? t.tool.name,
        parameters: (fn.parameters ?? {}) as Record<string, unknown>,
      };
    });
    // First, so it is read even where a long list is cut short.
    return [...OWN_PHONE_TOOLS, ...company];
  }

  /**
   * What the agent wrote for the caller, sent to their WhatsApp. Only to a number its owner
   * has proven, and only after a tool has answered on this call: the text is the agent's own,
   * so it must have had something to write from.
   */
  private async sendWhatsapp(call: CallRow | null, body: PhoneToolInput): Promise<PhoneToolReply> {
    let message = '';
    try {
      const args = JSON.parse(body.arguments?.trim() || '{}') as { message?: unknown };
      if (typeof args.message === 'string') message = args.message.trim();
    } catch {
      // Not JSON: answered below like a missing message.
    }
    if (!message) return fail('Give the text to send in "message", as {"message":"…"}.');
    if (message.length > SEND_WHATSAPP_MAX) {
      return fail(`The message is too long. Keep it under ${SEND_WHATSAPP_MAX} characters.`);
    }
    const { phone, owner } = await this.party(call, body.phone);
    if (!phone || !owner) return fail(NOT_LINKED);
    if (!call?.toolCallIds.length) return fail(LOOK_UP_FIRST);
    const { companyName } = await this.branding.get();
    const outcome = await this.links.sendNotice({
      phone,
      text: `From your call with ${companyName}:\n${message}`,
      about: 'Details the caller asked for in writing',
      callId: call.id,
    });
    if (outcome.sent) return ok(MESSAGE_SENT);
    const emailed = await this.email({
      to: owner.email,
      subject: `From your call with ${companyName}`,
      text: message,
      about: 'Details the caller asked for in writing',
      callId: call.id,
    });
    return emailed ? ok(MESSAGE_EMAILED) : fail(MESSAGE_NOT_SENT);
  }

  /**
   * The same thing by email, for a caller WhatsApp cannot reach (no message from them in
   * the last 24 hours, or no WhatsApp at the desk). Only ever to the address on the file
   * of the customer this number is proven to belong to.
   */
  private async email(i: {
    to: string | null | undefined;
    subject: string;
    text: string;
    about: string;
    callId: string | null;
  }): Promise<boolean> {
    if (!i.to || !i.callId) return false;
    return this.mail
      .queue(AI_CTX, {
        to: i.to,
        subject: i.subject,
        text: i.text,
        about: i.about,
        target: { type: 'voice_call', id: i.callId },
      })
      .catch((err: Error) => {
        this.logger.warn(`an email to a caller was not queued: ${err.message}`);
        return false;
      });
  }

  /** The desk's own tools that link a caller's number to an email address. */
  private async linkTool(
    name: string,
    call: CallRow | null,
    body: PhoneToolInput,
  ): Promise<PhoneToolReply> {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(body.arguments?.trim() || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: answered by the tool like a missing input.
    }
    const phone =
      call?.direction === 'outbound' ? call.callerPhone : (body.phone ?? call?.callerPhone ?? null);
    const answer =
      name === VERIFY_EMAIL
        ? await this.emailLink.start(call, phone, args.email)
        : await this.emailLink.confirm(call, phone, args.code);
    return answer.ok ? ok(answer.text) : fail(answer.text);
  }

  /** The call begins: who is calling, and what the agent can use. */
  async start(
    input: PhoneStartInput,
    provider: PhoneProviderId = 'sarvam',
  ): Promise<PhoneStartReply> {
    const caller = await this.caller(input.phone, provider);
    const call = await this.open(input.interactionId, caller, provider);
    const { owner } = await this.party(call, caller);
    // A caller whose number is registered is greeted by first name, with or without a title
    // on file (the product owner's choice for phone calls); nothing when the name on file
    // is not a person's name (ADR 0037).
    const name = owner ? (addressOf(owner.name, null)?.short ?? '') : '';
    const company = (await this.branding.get()).companyName;
    return {
      customer_name: name,
      // The start hook also runs on a call the desk placed: answering "thanks for calling"
      // there replaced the greeting the call was placed with.
      greeting:
        call?.direction === 'outbound'
          ? outboundGreeting(name, company)
          : name
            ? `Hello ${name}, thanks for calling ${company}.`
            : `Hello, thanks for calling ${company}.`,
      known: !!owner,
      company,
      desk_tools: JSON.stringify(await this.catalogue()),
    };
  }

  /** One of the four tools a Sarvam agent holds; `desk_tool` carries the company's. */
  async run(
    tool: PhoneToolName,
    body: PhoneToolInput,
    provider: PhoneProviderId = 'sarvam',
  ): Promise<PhoneToolReply> {
    return this.inTime(tool, () => this.answer(tool, body, provider));
  }

  /**
   * One tool by its own name, with its inputs as they are: how an agent that
   * holds each tool by name (ElevenLabs) reaches the desk. `key` is a company
   * tool's id here, or the name of one of the desk's own phone tools.
   */
  async runNamed(
    provider: PhoneProviderId,
    key: string,
    ref: { interactionId: string | null; phone: string | null },
    args: Record<string, unknown>,
  ): Promise<PhoneToolReply> {
    const text = (v: unknown, max: number) =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
    const input: PhoneToolInput = {
      interactionId: ref.interactionId,
      phone: ref.phone,
      name: undefined,
      arguments: JSON.stringify(args),
      query: text(args.query, 500),
      reason: text(args.reason, 500),
    };
    return this.inTime(key, async () => {
      if (key === 'search_knowledge' || key === 'request_person') {
        return this.answer(key, input, provider);
      }
      const body = { ...input, phone: await this.caller(input.phone, provider) };
      const call = await this.open(body.interactionId, body.phone, provider);
      if (key === SEND_WHATSAPP) return this.sendWhatsapp(call, body);
      if (key === VERIFY_EMAIL || key === CONFIRM_EMAIL_CODE) return this.linkTool(key, call, body);
      const found = (await this.tools.agentTools()).find((t) => t.tool.id === key);
      if (!found) {
        return fail('That tool is not available any more. Tell the caller you cannot do that now.');
      }
      return this.deskTool(call, { ...body, name: found.qualifiedName });
    });
  }

  /**
   * Always answers, and in time: whatever goes wrong here, the caller is on
   * the line and the agent needs something to say.
   */
  private inTime(label: string, work: () => Promise<PhoneToolReply>): Promise<PhoneToolReply> {
    const answer = work().catch((err: Error) => {
      this.logger.warn(`phone tool ${label} failed: ${err.message}`);
      return fail(WENT_WRONG);
    });
    return Promise.race([
      answer,
      new Promise<PhoneToolReply>((resolve) =>
        setTimeout(() => resolve(fail(TOO_LONG)), TOOL_DEADLINE_MS),
      ),
    ]);
  }

  /** The caller's number in the form proven numbers are stored in (with the country code). */
  private async caller(phone: string | null, provider: PhoneProviderId): Promise<string | null> {
    // A number from the provider's own country can arrive in national form (`0XXXXXXXXXX`,
    // seen on Sarvam's first real call; Exotel and SIP trunks do the same). It takes the
    // country code of the number the agent answers on.
    const agentNumber =
      provider === 'sarvam'
        ? (await this.channels.phone())?.agentPhoneNumber
        : (await this.channels.elevenlabsSync())?.agentNumber;
    return internationalCallerNumber(phone, agentNumber ?? '');
  }

  private async answer(
    tool: PhoneToolName,
    input: PhoneToolInput,
    provider: PhoneProviderId,
  ): Promise<PhoneToolReply> {
    const body = { ...input, phone: await this.caller(input.phone, provider) };
    // The start hook may never have arrived: any tool call opens the call's record.
    const call = await this.open(body.interactionId, body.phone, provider);
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

  /** What the agent is told about a written confirmation: sent to WhatsApp, or not. */
  private async confirm(i: {
    text: string;
    phone: string | null;
    email: string | null;
    callId: string | null;
    about: string;
  }): Promise<string> {
    if (!i.phone) return CONFIRMATION_NOT_SENT;
    const outcome = await this.links.sendNotice({ ...i, phone: i.phone });
    if (outcome.sent) return CONFIRMATION_SENT;
    const emailed = await this.email({
      to: i.email,
      subject: i.about,
      text: i.text,
      about: i.about,
      callId: i.callId,
    });
    return emailed ? CONFIRMATION_EMAILED : CONFIRMATION_NOT_SENT;
  }

  /** What the agent is told about a link in a tool's answer: sent to WhatsApp, or not. */
  private async shareLink(i: {
    link: string;
    phone: string | null;
    email: string | null;
    callId: string | null;
    about: string;
  }): Promise<string> {
    if (!i.phone) return LINK_NOT_SENT;
    // Without a template the link still goes to a caller who wrote on WhatsApp in the last day.
    const templateName = (await this.channels.calls()).linkTemplate?.trim() || null;
    // Asked for twice on one call (the agent retries, the caller asks again): sent once.
    const key = `${i.callId ?? i.phone}:${i.link}`;
    const now = Date.now();
    for (const [k, sent] of this.linksSent) {
      if (now - sent.at > LINK_REPEAT_MS) this.linksSent.delete(k);
    }
    const before = this.linksSent.get(key);
    if (before) return before.by === 'email' ? LINK_EMAILED : LINK_SENT;
    const outcome = await this.links.send({ ...i, phone: i.phone, templateName });
    if (outcome.sent) {
      this.linksSent.set(key, { at: now, by: 'whatsapp' });
      return LINK_SENT;
    }
    const emailed = await this.email({
      to: i.email,
      subject: i.about,
      text: `${i.about}, as you asked on your call with us:\n${i.link}`,
      about: i.about,
      callId: i.callId,
    });
    if (!emailed) return LINK_NOT_SENT;
    this.linksSent.set(key, { at: now, by: 'email' });
    return LINK_EMAILED;
  }

  /**
   * The call's record, opened if this is the first we hear of the call. Null
   * for a request with no call id: a tool tried from Sarvam's dashboard, which
   * gets a real answer and leaves no record.
   */
  private async open(
    interactionId: string | null,
    phone: string | null,
    provider: PhoneProviderId,
  ): Promise<CallRow | null> {
    if (interactionId) {
      // Sarvam names a call we placed only when it reports on it. A tool used before that
      // belongs to the call under way to this number.
      const placed =
        phone && provider === 'sarvam'
          ? await this.calls.adoptOutbound(provider, phone, interactionId)
          : null;
      return placed ?? this.calls.beginPhone({ provider, interactionId, phone });
    }
    // A tool that cannot name its call (a code tool at Sarvam has the caller's number but
    // not always the call's id) still belongs to the call that number is on.
    return phone ? this.calls.activeForCaller(phone) : null;
  }

  /**
   * Who is on the line. On a call that came in: the proven owner of the number the request
   * carries, or of the one on the call's record. On a call the desk placed: the customer it
   * rang, from the call's own record, whatever the request says.
   */
  private async party(call: CallRow | null, requestPhone: string | null) {
    if (call?.direction === 'outbound') {
      // Tools act for them only when the number rung is one they proved is theirs: whoever
      // answers another number on their file gets general help, not their account.
      const proven = call.customerId ? await this.customers.provenPhoneOf(call.customerId) : null;
      return {
        phone: call.callerPhone,
        owner:
          call.customerId && proven && proven === call.callerPhone
            ? await this.customers.contactOf(call.customerId)
            : null,
      };
    }
    const phone = requestPhone ?? call?.callerPhone ?? null;
    return { phone, owner: phone ? await this.customers.provenPhoneOwner(phone) : null };
  }

  /**
   * The company's tools a phone agent may use right now. One that needs an approval is
   * offered too: the request is passed on and the caller is rung back with the answer.
   */
  async offered(): Promise<AgentTool[]> {
    return this.tools.agentTools();
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

  /** A company tool, or the desk's own send_whatsapp. A refusal is logged with what was sent. */
  private async deskTool(call: CallRow | null, body: PhoneToolInput): Promise<PhoneToolReply> {
    const reply = await this.runDeskTool(call, body);
    if (!reply.ok) {
      this.logger.warn(
        `phone tool "${body.name ?? ''}" with inputs [${inputNames(body.arguments)}] was refused: ${reply.result.slice(0, 240)}`,
      );
    }
    return reply;
  }

  private async runDeskTool(call: CallRow | null, body: PhoneToolInput): Promise<PhoneToolReply> {
    const name = body.name ?? '';
    if (name === SEND_WHATSAPP) return this.sendWhatsapp(call, body);
    if (name === VERIFY_EMAIL || name === CONFIRM_EMAIL_CODE)
      return this.linkTool(name, call, body);
    const all = await this.tools.agentTools();
    const byBareName = all.filter((t) => t.tool.name === name);
    const found =
      all.find((t) => t.qualifiedName === name) ??
      (byBareName.length === 1 ? byBareName[0] : undefined);
    if (!found) {
      const names = (await this.offered()).map((t) => t.qualifiedName).join(', ');
      return fail(`There is no tool called "${name}". The tools are: ${names}.`);
    }

    // The number this token-protected request carries; the call's record (set only by such
    // requests) when this one has none.
    const { phone, owner } = await this.party(call, body.phone);
    // The catalogue is in English too: a search for "लाल कुर्ता" would find nothing.
    const sent = fitted(
      found,
      await this.translator.argumentsToEnglish(body.arguments?.trim() || '{}'),
    );
    const args = sent.args;
    if (sent.dropped.length) {
      this.logger.warn(
        `phone tool "${found.qualifiedName}": dropped inputs it does not have [${sent.dropped.join(', ')}]`,
      );
    }
    /** Why the gateway refused, with the tool's inputs spelled out for the next try. */
    const refused = (error: string) =>
      fail(found.tool.customerArg && !owner?.email ? NOT_LINKED : error + inputsOf(found));
    if (found.tool.tier === 'transactional') {
      // An approval belongs to a ticket, and this call has none until it ends. The request is
      // checked now, so the agent can correct a wrong input while the caller is on the line,
      // and kept on the call's record; the job that writes the ticket asks for the approval.
      if (!call) return fail(NEEDS_COLLEAGUE);
      const check = await this.gateway.invoke(AI_CTX, {
        tool: found.tool,
        server: found.server,
        args,
        ticketId: null,
        conversationId: null,
        customerEmail: owner?.email ?? null,
        dryRun: true,
      });
      if (check.status === 'denied') return refused(check.error);
      if (check.status === 'error') return fail(check.error);
      // Asked for twice on one call (the agent repeats a tool): one approval, not two.
      const again = call.pendingApprovals.some(
        (p) => p.toolId === found.tool.id && p.args === args,
      );
      if (!again) await this.calls.notePendingApproval(call.id, { toolId: found.tool.id, args });
      return ok(APPROVAL_NEEDED);
    }
    const run = this.gateway.invoke(AI_CTX, {
      tool: found.tool,
      server: found.server,
      args,
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
      case 'ok': {
        const link = linkIn(r.result);
        // A link cannot be read out: it goes to the caller's WhatsApp, and the agent is told
        // whether it did. Only ever to the number this caller has proven is theirs.
        const note = link
          ? await this.shareLink({
              link,
              phone: owner && phone ? phone : null,
              email: owner?.email ?? null,
              callId: call?.id ?? null,
              about: found.tool.title ?? found.tool.name,
            })
          : '';
        const confirmation = confirmationIn(r.result);
        const confirmed = confirmation
          ? await this.confirm({
              text: confirmation,
              phone: owner && phone ? phone : null,
              email: owner?.email ?? null,
              callId: call?.id ?? null,
              about: found.tool.title ?? found.tool.name,
            })
          : '';
        // Only a caller with a proven number can be written to.
        const canSend =
          owner && phone ? CAN_SEND[(call?.provider as PhoneProviderId | null) ?? 'sarvam'] : '';
        return ok(
          FROM_SYSTEM +
            canSend +
            note +
            confirmed +
            (typeof r.result === 'string'
              ? r.result
              : JSON.stringify(withoutAddresses(r.result ?? {}))),
        );
      }
      case 'denied':
        return refused(r.error);
      case 'error':
        return fail(r.error);
      default:
        return fail(NEEDS_COLLEAGUE);
    }
  }
}
