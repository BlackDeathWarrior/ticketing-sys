import { Injectable } from '@nestjs/common';
import { ChannelConfigService } from '../../../settings/channel-config.service';
import type { PhoneRecording } from '../phone-provider';

const TIMEOUT_MS = 10_000;
const RECORDING_TIMEOUT_MS = 60_000;
/** As for Sarvam: anything larger is not a call. */
const RECORDING_MAX_BYTES = 120 * 1024 * 1024;

/** ElevenLabs refused or failed: `message` is its own wording, never a key. */
export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ElevenLabsNumber {
  id: string;
  number: string;
  label: string;
  provider: 'twilio' | 'sip_trunk' | 'exotel';
  agentId: string | null;
}

/**
 * ElevenLabs' Agents API (ADR 0040), read from its API reference on
 * 2026-10-04: the paths and field names here are that reference's. Every
 * method throws `ElevenLabsError` with ElevenLabs' message when it refuses.
 */
@Injectable()
export class ElevenLabsClient {
  constructor(private readonly channels: ChannelConfigService) {}

  /** A conversation as ElevenLabs keeps it, or null when it knows none by that id. */
  async conversation(id: string): Promise<unknown | null> {
    const res = await this.send('GET', `/v1/convai/conversations/${encodeURIComponent(id)}`, {
      allow: [404],
    });
    return res.status === 404 ? null : res.json();
  }

  /** The call's audio, or null when there is none (yet) or it is not audio of a sensible size. */
  async conversationAudio(id: string): Promise<PhoneRecording | null> {
    const res = await this.send('GET', `/v1/convai/conversations/${encodeURIComponent(id)}/audio`, {
      allow: [404, 422],
      timeoutMs: RECORDING_TIMEOUT_MS,
    });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!res.ok || !type.startsWith('audio/')) return null;
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length || audio.length > RECORDING_MAX_BYTES) return null;
    const isWav = audio.subarray(0, 4).toString('latin1') === 'RIFF';
    return { audio, type: isWav ? 'audio/wav' : 'audio/mpeg' };
  }

  async listPhoneNumbers(): Promise<ElevenLabsNumber[]> {
    const res = await this.send('GET', '/v1/convai/phone-numbers');
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    return rows.map((n) => ({
      id: String(n.phone_number_id ?? ''),
      number: String(n.phone_number ?? ''),
      label: String(n.label ?? ''),
      provider: n.provider as ElevenLabsNumber['provider'],
      agentId: (n.assigned_agent as { agent_id?: string } | null)?.agent_id ?? null,
    }));
  }

  async assignNumber(phoneNumberId: string, agentId: string): Promise<void> {
    await this.send('PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
      body: { agent_id: agentId },
    });
  }

  /** Stores a value at ElevenLabs for tool and webhook headers; returns the secret's id. */
  async createSecret(name: string, value: string): Promise<string> {
    const res = await this.send('POST', '/v1/convai/secrets', {
      body: { type: 'new', name, value },
    });
    return ((await res.json()) as { secret_id: string }).secret_id;
  }

  async createTool(toolConfig: unknown): Promise<string> {
    const res = await this.send('POST', '/v1/convai/tools', { body: { tool_config: toolConfig } });
    return ((await res.json()) as { id: string }).id;
  }

  async updateTool(id: string, toolConfig: unknown): Promise<void> {
    await this.send('PATCH', `/v1/convai/tools/${encodeURIComponent(id)}`, {
      body: { tool_config: toolConfig },
    });
  }

  /** A tool ElevenLabs no longer has is as good as deleted. */
  async deleteTool(id: string): Promise<void> {
    await this.send('DELETE', `/v1/convai/tools/${encodeURIComponent(id)}`, { allow: [404] });
  }

  async createAgent(body: unknown): Promise<string> {
    const res = await this.send('POST', '/v1/convai/agents/create', { body });
    return ((await res.json()) as { agent_id: string }).agent_id;
  }

  async updateAgent(id: string, body: unknown): Promise<void> {
    await this.send('PATCH', `/v1/convai/agents/${encodeURIComponent(id)}`, { body });
  }

  /**
   * Rings a number from the agent's own. The path depends on how that number reaches
   * ElevenLabs; for a kind whose path we have not read, the call is refused here.
   */
  async outboundCall(kind: string, body: unknown): Promise<string> {
    const path =
      kind === 'twilio'
        ? '/v1/convai/twilio/outbound-call'
        : kind === 'sip_trunk'
          ? '/v1/convai/sip-trunk/outbound-call'
          : null;
    if (!path) {
      throw new ElevenLabsError(0, 'Outbound calls are not available for this kind of number yet');
    }
    const res = await this.send('POST', path, { body });
    const answer = (await res.json()) as { conversation_id?: string | null; message?: string };
    if (!answer.conversation_id) {
      throw new ElevenLabsError(200, `ElevenLabs did not start the call: ${answer.message ?? ''}`);
    }
    return answer.conversation_id;
  }

  /** The signed post-call webhook. The secret comes back once, here. */
  async createWebhook(name: string, url: string): Promise<{ id: string; secret: string }> {
    const res = await this.send('POST', '/v1/workspace/webhooks', {
      body: { settings: { auth_type: 'hmac', name, webhook_url: url } },
    });
    const body = (await res.json()) as { webhook_id: string; webhook_secret?: string | null };
    if (!body.webhook_secret) {
      throw new ElevenLabsError(200, 'ElevenLabs created the webhook but returned no secret');
    }
    return { id: body.webhook_id, secret: body.webhook_secret };
  }

  private async send(
    method: string,
    path: string,
    opts: { body?: unknown; allow?: number[]; timeoutMs?: number } = {},
  ): Promise<Response> {
    const c = await this.channels.elevenlabs();
    if (!c?.apiKey) throw new ElevenLabsError(0, 'The ElevenLabs API key is not set');
    const res = await fetch(new URL(path, c.baseUrl), {
      method,
      headers: {
        'xi-api-key': c.apiKey,
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (res.ok || opts.allow?.includes(res.status)) return res;
    throw new ElevenLabsError(res.status, await reasonOf(res));
  }
}

/** ElevenLabs' own words for a refusal: `detail.message`, a validation list, or the body's start. */
async function reasonOf(res: Response): Promise<string> {
  // Parsed whole: a refusal can quote the request back, and half a JSON says nothing.
  const text = await res.text().catch(() => '');
  let said = text;
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof detail === 'string') said = detail;
    else if (Array.isArray(detail)) {
      said = detail
        .map((d) => {
          const item = d as { loc?: unknown[]; msg?: string };
          return `${(item.loc ?? []).join('.')}: ${item.msg ?? ''}`;
        })
        .join('; ');
    } else if (detail && typeof detail === 'object') {
      said = String((detail as { message?: unknown }).message ?? text);
    }
  } catch {
    // Not JSON: the text is all there is.
  }
  return `ElevenLabs answered HTTP ${res.status}${said ? `: ${said.slice(0, 300)}` : ''}`;
}
