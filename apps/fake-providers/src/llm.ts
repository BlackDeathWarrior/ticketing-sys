import {
  agentReply,
  classifierReply,
  isAgentRequest,
  isClassifierRequest,
  isSummaryRequest,
  summaryReply,
} from './agent-script';

/**
 * A scripted, OpenAI-compatible LLM. Replies are deterministic so demos and
 * tests can assert on them. Model names change behaviour:
 *
 * - `always-fails`: HTTP 500 (to exercise fallbacks)
 * - anything else: a scripted reply
 */

export interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: string; function: { name: string } }>;
  max_tokens?: number;
}

export interface ScriptedReply {
  content: string | null;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** Rules are tried in order; the first match answers. Later phases add AI-agent scripts here. */
export const CHAT_RULES: Array<{
  when: (lastUser: string, req: ChatRequest) => boolean;
  reply: (lastUser: string, req: ChatRequest) => ScriptedReply;
}> = [
  {
    when: (text) => /single word ok/i.test(text),
    reply: () => ({ content: 'OK' }),
  },
];

export function textOf(content: ChatMessage['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => p.text ?? '').join(' ');
}

export function scriptedReply(req: ChatRequest): ScriptedReply {
  if (isAgentRequest(req)) return agentReply(req);
  if (isClassifierRequest(req)) return classifierReply(req);
  if (isSummaryRequest(req)) return summaryReply(req);
  const lastUser = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content);
  for (const rule of CHAT_RULES) if (rule.when(lastUser, req)) return rule.reply(lastUser, req);
  const snippet = lastUser.replace(/\s+/g, ' ').trim().slice(0, 80);
  return { content: `Scripted reply from ${req.model}: "${snippet}"` };
}

const countTokens = (text: string) =>
  Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3));

export function chatCompletion(req: ChatRequest) {
  const reply = scriptedReply(req);
  const promptTokens = countTokens(req.messages.map((m) => textOf(m.content)).join(' '));
  const completionTokens = countTokens(reply.content ?? JSON.stringify(reply.toolCalls ?? []));
  const toolCalls = reply.toolCalls?.map((c, i) => ({
    id: `call_${i}_${c.name}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
  return {
    id: `chatcmpl-fake-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: reply.content,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Hashed bag-of-words vectors, L2-normalised: texts that share words land
 * close together, so knowledge-base search behaves sensibly in tests.
 */
export function embed(text: string, dimensions = 1024): number[] {
  const v = new Array<number>(dimensions).fill(0);
  const words = text
    .toLowerCase()
    .normalize('NFKC')
    // \p{M} keeps combining marks (Devanagari vowel signs) inside their word.
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1);
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dimensions]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
