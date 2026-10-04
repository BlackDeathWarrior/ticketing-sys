import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, phoneAgentTools } from '@tms/db';
import type { ElevenlabsSyncState, PhoneToolEntry } from '@tms/shared';
import { eq } from 'drizzle-orm';
import { SYSTEM_CTX } from '../../../common/request-context';
import type { Env } from '../../../config/env';
import { DB, ENV } from '../../../infra/tokens';
import { AppSettingsService } from '../../../settings/app-settings.service';
import { BrandingService } from '../../../settings/branding.service';
import { ChannelConfigService } from '../../../settings/channel-config.service';
import { SecretsService } from '../../../settings/secrets.service';
import { ToolsService } from '../../../tools/tools.service';
import { PHONE_AGENT_INSTRUCTION_VERSION, phoneAgentInstruction } from '../phone-agent-instruction';
import { SEND_WHATSAPP_ENTRY } from '../phone-tools.service';
import { ELEVENLABS_SYNC_KEY, syncStateSchema } from './elevenlabs-sync-state';
import { ElevenLabsClient, ElevenLabsError } from './elevenlabs.client';

const PROVIDER = 'elevenlabs';
/** ElevenLabs waits this long for a tool; the desk answers within 25 seconds. */
const TOOL_TIMEOUT_SECONDS = 30;
const MAX_CALL_SECONDS = 600;
const SILENCE_HANG_UP_SECONDS = 45;
/**
 * ElevenLabs' rule, as its API put it on the first real set-up: "English Agents must use
 * turbo or flash v2". An agent that starts in another language needs the v2.5 model; for
 * the further languages of an English agent ElevenLabs switches to v2.5 by itself.
 */
const ENGLISH_TTS = 'eleven_flash_v2';
const MULTILINGUAL_TTS = 'eleven_flash_v2_5';
/**
 * The languages an ElevenLabs agent can switch to, as its API listed them when it refused
 * Bengali on the first real set-up (2026-10-04). One language outside the list fails the whole
 * agent, so such a language is left out and named on the card instead.
 */
const AGENT_LANGUAGES = new Set(
  'en zh es hi pt fr de ja ar ko id it nl tr pl ru sv tl ms ro uk el cs da fi bg hr sk ta vi no hu pt-br fil'.split(
    ' ',
  ),
);

const EMPTY: ElevenlabsSyncState = syncStateSchema.parse({});

/** The desk's own phone tools, offered to the agent next to the company's. */
const OWN_TOOLS: PhoneToolEntry[] = [
  {
    name: 'search_knowledge',
    description:
      'Looks up the company’s policies and help articles. Use it for delivery, returns, sizes and anything "how does it work". Answer only from what it returns.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The caller’s question, in English.' } },
      required: ['query'],
    },
  },
  {
    name: 'request_person',
    description:
      'Asks for a colleague to get back to the caller. Use it when you cannot help, or when the caller asks for a person a second time.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One sentence on why the caller needs a person.' },
      },
      required: ['reason'],
    },
  },
  SEND_WHATSAPP_ENTRY,
];

/** ElevenLabs no longer has what a stored id points at (deleted there, or another workspace's key). */
const gone = (err: unknown) => err instanceof ElevenLabsError && err.status === 404;

/** A name ElevenLabs accepts (letters, digits, `_`, `-`), unique among this agent's tools. */
export function elevenLabsToolName(qualifiedName: string, toolId: string, taken: Set<string>) {
  const base = qualifiedName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 56) || 'tool';
  const name = taken.has(base)
    ? `${base}_${toolId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)}`
    : base;
  taken.add(name);
  return name;
}

/**
 * A tool's input schema in the part of JSON Schema that ElevenLabs takes:
 * types, descriptions, enums, nested objects and lists. Everything a model
 * fills needs a description, so a field without one is described by its name.
 */
export function toElevenLabsSchema(schema: unknown, name = 'input'): Record<string, unknown> {
  let s = (schema ?? {}) as Record<string, unknown>;
  // `Optional[int]` from a Python tool server: the type sits in the first member that is not null.
  const options = [s.anyOf, s.oneOf].find(Array.isArray) as
    Array<Record<string, unknown>> | undefined;
  if (!s.type && options) s = { ...(options.find((o) => o?.type !== 'null') ?? {}), ...s };
  const type = Array.isArray(s.type)
    ? (s.type.find((t) => t !== 'null') ?? 'string')
    : (s.type ?? (s.properties ? 'object' : 'string'));
  const description = typeof s.description === 'string' && s.description ? s.description : name;
  if (type === 'object') {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    return {
      type: 'object',
      description,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, toElevenLabsSchema(value, key)]),
      ),
      required: Array.isArray(s.required) ? s.required : [],
    };
  }
  if (type === 'array') {
    return { type: 'array', description, items: toElevenLabsSchema(s.items, `${name} item`) };
  }
  return {
    type,
    description,
    // ElevenLabs lists choices as text; choices of a number are left to the description.
    ...(Array.isArray(s.enum) && type === 'string' ? { enum: s.enum.map(String) } : {}),
  };
}

/**
 * Sets the ElevenLabs agent up and keeps it in step with this desk (ADR
 * 0040): the hook token, one tool at ElevenLabs per tool here, the signed
 * post-call webhook, the agent itself and its number. Safe to run again: a
 * tool that did not change is not sent, and what exists is updated, not made
 * twice. The desk changes at ElevenLabs only what it created, by the ids it
 * stored; it never lists and deletes.
 */
@Injectable()
export class ElevenLabsAgentSync {
  private readonly logger = new Logger(ElevenLabsAgentSync.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
    private readonly settings: AppSettingsService,
    private readonly secrets: SecretsService,
    private readonly branding: BrandingService,
    private readonly tools: ToolsService,
    private readonly client: ElevenLabsClient,
  ) {}

  async state(): Promise<ElevenlabsSyncState> {
    return (
      (await this.settings.get(ELEVENLABS_SYNC_KEY, syncStateSchema, { fresh: true })) ?? EMPTY
    );
  }

  /**
   * Null when there is nothing to do (the card is off, or no key is saved).
   * One tool ElevenLabs refuses does not stop the run; a failure to write the
   * agent itself is recorded and thrown, so the job tries again.
   */
  async run(): Promise<ElevenlabsSyncState | null> {
    const config = await this.channels.elevenlabs();
    if (!config?.enabled || !config.apiKey) return null;
    const state: ElevenlabsSyncState = { ...(await this.state()), skipped: [], error: null };
    try {
      this.assertReachable();

      // 1. The token the agent's requests carry. ElevenLabs sends a stored secret as the
      // header's whole value, so what it stores is the header: "Bearer <token>".
      let token = config.hookToken;
      if (!token) {
        token = randomBytes(32).toString('hex');
        await this.secrets.set(SYSTEM_CTX, 'elevenlabs.hook_token', token);
        state.secretId = null;
      }
      if (!state.secretId) {
        state.secretId = await this.client.createSecret(
          `orbit-desk-hook-${Date.now()}`,
          `Bearer ${token}`,
        );
        // Saved at once, here and after every other create: a run that stops later must
        // not make the same thing a second time and leave the first behind at ElevenLabs.
        await this.save(state);
      }

      // 2. The tools. The agent keeps every tool that is already there, also one whose
      // update was refused: it never loses a tool that was working.
      const toolIds = await this.syncTools(state);

      // 3. The post-call webhook, made once: its secret is only ever shown at creation.
      if (!state.webhookId || !config.webhookSecret) {
        const hook = await this.client.createWebhook(
          'Orbit Desk: call ended',
          this.address('events'),
        );
        await this.secrets.set(SYSTEM_CTX, 'elevenlabs.webhook_secret', hook.secret);
        state.webhookId = hook.id;
        await this.save(state);
      }

      // 4. The agent. One ElevenLabs no longer knows (deleted there, or the key now belongs
      // to another workspace) is made again.
      const languages = config.moreLanguages
        .map((l) => l.toLowerCase())
        .filter((l) => l !== config.language.toLowerCase());
      // The list is the v2.5 model's. The v3 model speaks more languages (Bengali among them),
      // so with it ElevenLabs is the judge of what it takes.
      const speaks = (l: string) => config.voiceModel !== 'auto' || AGENT_LANGUAGES.has(l);
      for (const l of languages.filter((x) => !speaks(x))) {
        state.skipped.push({
          tool: `language ${l}`,
          reason:
            'The standard voice model cannot speak this language, so it was left out. The v3 voice model may.',
        });
      }
      const body = await this.agentBody(
        { ...config, moreLanguages: languages.filter(speaks) },
        state,
        toolIds.keep,
      );
      if (state.agentId) {
        try {
          await this.client.updateAgent(state.agentId, body);
        } catch (err) {
          if (!gone(err)) throw err;
          state.agentId = null;
        }
      }
      if (!state.agentId) {
        state.agentId = await this.client.createAgent(body);
        await this.save(state);
      }

      // Tools that left the desk are deleted only now that the agent no longer holds them.
      // One that cannot be deleted keeps its row for the next run and does not fail this one.
      for (const left of toolIds.gone) {
        try {
          await this.client.deleteTool(left.providerToolId);
          await this.db.delete(phoneAgentTools).where(eq(phoneAgentTools.id, left.id));
        } catch (err) {
          state.skipped.push({
            tool: left.name,
            reason: `Not removed at ElevenLabs: ${(err as Error).message.slice(0, 250)}`,
          });
        }
      }

      // 5. The number, once one is connected at ElevenLabs and chosen on the card. A number
      // id ElevenLabs does not list is said on the card; the agent is in step all the same.
      state.agentNumber = null;
      state.agentNumberKind = null;
      if (config.phoneNumberId) {
        const number = (await this.client.listPhoneNumbers()).find(
          (n) => n.id === config.phoneNumberId,
        );
        if (number) {
          await this.client.assignNumber(number.id, state.agentId);
          state.agentNumber = number.number;
          state.agentNumberKind = number.provider;
        } else {
          state.skipped.push({
            tool: 'number',
            reason: 'ElevenLabs lists no number with the id saved on the card.',
          });
        }
      }

      state.ok = true;
      state.tools = toolIds.keep.length;
    } catch (err) {
      state.ok = false;
      state.error = (err as Error).message.slice(0, 500);
      // The run's own error is what matters: a failure to record it must not replace it.
      await this.save(state).catch(() => undefined);
      throw err;
    }
    await this.save(state);
    return state;
  }

  private async syncTools(state: ElevenlabsSyncState) {
    const rows = await this.db
      .select()
      .from(phoneAgentTools)
      .where(eq(phoneAgentTools.provider, PROVIDER));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const taken = new Set<string>();

    // Tools that need an approval are left out until the outcome can reach the caller.
    const company = (await this.tools.agentTools())
      .filter((t) => t.tool.tier !== 'transactional')
      .map((t) => {
        const fn = (t.definition as { function: { description?: string; parameters?: unknown } })
          .function;
        return {
          key: t.tool.id,
          path: `tools/desk/${t.tool.id}`,
          label: t.qualifiedName,
          name: elevenLabsToolName(t.qualifiedName, t.tool.id, taken),
          description: fn.description ?? t.tool.name,
          parameters: fn.parameters,
        };
      });
    const own = OWN_TOOLS.map((t) => ({
      key: t.name,
      path: `tools/${t.name}`,
      label: t.name,
      name: elevenLabsToolName(t.name, t.name, taken),
      description: t.description,
      parameters: t.parameters as unknown,
    }));

    const keep: string[] = [];
    for (const tool of [...own, ...company]) {
      const config = {
        type: 'webhook',
        name: tool.name,
        description: tool.description.slice(0, 1_000),
        response_timeout_secs: TOOL_TIMEOUT_SECONDS,
        api_schema: {
          url: this.address(tool.path),
          method: 'POST',
          request_headers: {
            Authorization: { type: 'secret', secret_id: state.secretId },
            // Filled by ElevenLabs from its own variables: the agent's model never sees them.
            'X-Call-Id': { type: 'dynamic_variable', variable_name: 'system__conversation_id' },
            'X-Caller': { type: 'dynamic_variable', variable_name: 'system__caller_id' },
          },
          request_body_schema: toElevenLabsSchema(tool.parameters, tool.name),
        },
      };
      const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const row = byKey.get(tool.key);
      byKey.delete(tool.key);
      try {
        if (!row) {
          const providerToolId = await this.client.createTool(config);
          await this.db
            .insert(phoneAgentTools)
            .values({ provider: PROVIDER, key: tool.key, providerToolId, name: tool.name, hash });
          keep.push(providerToolId);
          continue;
        }
        if (row.hash === hash) {
          keep.push(row.providerToolId);
          continue;
        }
        let providerToolId = row.providerToolId;
        try {
          await this.client.updateTool(providerToolId, config);
        } catch (err) {
          if (!gone(err)) {
            // Refused as it is now: the tool stays on the agent as it was.
            keep.push(row.providerToolId);
            throw err;
          }
          providerToolId = await this.client.createTool(config);
        }
        await this.db
          .update(phoneAgentTools)
          .set({ providerToolId, name: tool.name, hash, syncedAt: new Date() })
          .where(eq(phoneAgentTools.id, row.id));
        keep.push(providerToolId);
      } catch (err) {
        this.logger.warn(
          `tool ${tool.label} was not synced to ElevenLabs: ${(err as Error).message}`,
        );
        state.skipped.push({ tool: tool.label, reason: (err as Error).message.slice(0, 300) });
      }
    }
    return { keep, gone: [...byKey.values()] };
  }

  private async agentBody(
    config: NonNullable<Awaited<ReturnType<ChannelConfigService['elevenlabs']>>>,
    state: ElevenlabsSyncState,
    toolIds: string[],
  ) {
    const { companyName } = await this.branding.get();
    const english = config.language === 'en' || config.language.startsWith('en-');
    return {
      name: `${companyName} phone assistant (Orbit Desk, instruction v${PHONE_AGENT_INSTRUCTION_VERSION})`,
      conversation_config: {
        agent: {
          // Filled by the start webhook; these values greet a caller when it did not answer.
          first_message: '{{greeting}}',
          language: config.language,
          dynamic_variables: {
            dynamic_variable_placeholders: {
              greeting: `Hello, thanks for calling ${companyName}.`,
              customer_name: '',
              known: 'false',
              company: companyName,
              // Filled when the desk places the call itself.
              direction: 'inbound',
              about: '',
              ticket_reference: '',
            },
          },
          prompt: {
            prompt: phoneAgentInstruction('elevenlabs'),
            llm: config.model,
            tool_ids: toolIds,
            built_in_tools: {
              end_call: { name: 'end_call' },
              language_detection: { name: 'language_detection' },
            },
          },
        },
        tts: {
          voice_id: config.voiceId,
          model_id:
            config.voiceModel !== 'auto'
              ? config.voiceModel
              : english
                ? ENGLISH_TTS
                : MULTILINGUAL_TTS,
        },
        turn: { silence_end_call_timeout: SILENCE_HANG_UP_SECONDS },
        conversation: { max_duration_seconds: MAX_CALL_SECONDS },
        language_presets: Object.fromEntries(
          config.moreLanguages.map((l) => [l, { overrides: { agent: { language: l } } }]),
        ),
      },
      platform_settings: {
        overrides: { enable_conversation_initiation_client_data_from_webhook: true },
        workspace_overrides: {
          conversation_initiation_client_data_webhook: {
            url: this.address('start'),
            request_headers: { Authorization: { secret_id: state.secretId } },
          },
          // The audio is fetched with our key when the call is closed, not pushed to us.
          webhooks: {
            post_call_webhook_id: state.webhookId,
            events: ['transcript', 'call_initiation_failure'],
            send_audio: false,
          },
        },
        privacy: { record_voice: true },
      },
    };
  }

  /**
   * ElevenLabs calls the desk from the internet. With a local address every tool and
   * webhook would point nowhere while the card said "in step", so the run stops here.
   */
  private assertReachable(): void {
    const url = new URL(this.env.HELP_CENTER_URL);
    const local = /^(localhost|127\.|10\.|192\.168\.|\[?::1\]?$)/.test(url.hostname);
    if (url.protocol !== 'https:' || local) {
      throw new Error(
        'This desk has no public https address (HELP_CENTER_URL), so ElevenLabs could not reach it.',
      );
    }
  }

  /** Where ElevenLabs reaches this desk: the API behind the help center's public address. */
  private address(path: string): string {
    return new URL(`/api/v1/phone/elevenlabs/${path}`, this.env.HELP_CENTER_URL).toString();
  }

  private async save(state: ElevenlabsSyncState): Promise<void> {
    const next = { ...state, at: new Date().toISOString() };
    // On record like a connection test: when, whether it worked, never a key.
    await this.settings.set(SYSTEM_CTX, ELEVENLABS_SYNC_KEY, next, {
      action: 'elevenlabs_agent_synced',
      ok: next.ok,
      tools: next.tools,
      skipped: next.skipped.length,
    });
  }
}
