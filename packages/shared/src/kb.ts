import { z } from 'zod';

/**
 * Knowledge base (Phase 4, ADR 0010). Documents are reviewed (`draft` →
 * `approved`, or `archived`) and indexed in the background (`pending` →
 * `indexing` → `indexed` | `failed`). Only approved, indexed documents are
 * searched, and customer-facing answers only ever use `public` ones.
 */
export const KB_SOURCES = ['file', 'url', 'faq', 'text'] as const;
export type KbSource = (typeof KB_SOURCES)[number];

export const KB_VISIBILITIES = ['public', 'internal', 'team'] as const;
export const kbVisibilitySchema = z.enum(KB_VISIBILITIES);
export type KbVisibility = z.infer<typeof kbVisibilitySchema>;

export const KB_STATUSES = ['draft', 'approved', 'archived'] as const;
export const kbStatusSchema = z.enum(KB_STATUSES);
export type KbStatus = z.infer<typeof kbStatusSchema>;

export const KB_INDEX_STATES = ['pending', 'indexing', 'indexed', 'failed'] as const;
export type KbIndexState = (typeof KB_INDEX_STATES)[number];

/** Every embedding is stored at this size (ADR 0010). */
export const KB_EMBEDDING_DIMENSIONS = 1024;
/** Largest upload accepted. */
export const KB_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const KB_FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/html': 'html',
  'text/plain': 'txt',
} as const;
export const KB_FILE_EXTENSIONS = ['pdf', 'docx', 'md', 'markdown', 'html', 'htm', 'txt'] as const;

const title = z.string().trim().min(1).max(200);
const visibilityFields = {
  visibility: kbVisibilitySchema.default('internal'),
  teamId: z.string().uuid().nullable().default(null),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Like en or hi-IN')
    .nullable()
    .default(null),
};

function teamRule(v: { visibility: KbVisibility; teamId: string | null }, ctx: z.RefinementCtx) {
  if (v.visibility === 'team' && !v.teamId) {
    ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'Pick the team that may see it' });
  }
}

/** Manual entries and URLs (files go through the multipart upload endpoint). */
export const createKbDocumentSchema = z
  .discriminatedUnion('source', [
    z.object({
      source: z.literal('faq'),
      title,
      /** The answer; the title is the question. */
      content: z.string().trim().min(1).max(50_000),
      ...visibilityFields,
    }),
    z.object({
      source: z.literal('text'),
      title,
      content: z.string().trim().min(1).max(500_000),
      ...visibilityFields,
    }),
    z.object({
      source: z.literal('url'),
      title,
      url: z.string().trim().url().max(2_000),
      ...visibilityFields,
    }),
  ])
  .superRefine(teamRule);
export type CreateKbDocumentInput = z.infer<typeof createKbDocumentSchema>;

/** Form fields sent with a file upload. */
export const uploadKbFieldsSchema = z
  .object({ title: title.optional(), ...visibilityFields })
  .superRefine(teamRule);

export const updateKbDocumentSchema = z
  .object({
    title,
    visibility: kbVisibilitySchema,
    teamId: z.string().uuid().nullable(),
    language: visibilityFields.language,
    /** FAQ and text documents only: new content creates a new version. */
    content: z.string().trim().min(1).max(500_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateKbDocumentInput = z.infer<typeof updateKbDocumentSchema>;

export const setKbStatusSchema = z.object({ status: kbStatusSchema });

export const listKbDocumentsQuerySchema = z.object({
  status: kbStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const KB_AUDIENCES = ['agent', 'customer'] as const;
export type KbAudience = (typeof KB_AUDIENCES)[number];

export const kbSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  /** `customer`: public documents only (what the AI may quote to customers). */
  audience: z.enum(KB_AUDIENCES).default('agent'),
  /** Managers can preview drafts. */
  includeDrafts: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});
export type KbSearchQuery = z.infer<typeof kbSearchQuerySchema>;

// ---- Views ----

export interface KbDocumentView {
  id: string;
  title: string;
  source: KbSource;
  visibility: KbVisibility;
  team: { id: string; name: string } | null;
  language: string | null;
  status: KbStatus;
  indexState: KbIndexState;
  indexError: string | null;
  /** `keyword` when no embedding model was available: search falls back to full text. */
  indexMode: 'hybrid' | 'keyword' | null;
  version: number;
  chunkCount: number;
  url: string | null;
  filename: string | null;
  sizeBytes: number | null;
  createdBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  approvedAt: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbDocumentDetail extends KbDocumentView {
  /** The extracted text (FAQ answer, text body, or what indexing extracted from a file or URL). */
  content: string | null;
}

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  /** Heading trail inside the document, e.g. "Refunds › Card payments". */
  section: string | null;
  snippet: string;
  /** Reciprocal-rank-fusion score (higher is better). */
  score: number;
  /** Cosine similarity of the vector match, when there was one (0–1). */
  similarity: number | null;
  matchedBy: Array<'vector' | 'keyword'>;
  visibility: KbVisibility;
  version: number;
  /** Where the answer came from: the source URL, or the document's download link. */
  citation: { label: string; url: string | null };
}

export interface KbSearchResult {
  query: string;
  mode: 'hybrid' | 'keyword';
  hits: KbSearchHit[];
}

/** Reciprocal rank fusion: each list contributes 1/(k + rank) per item. */
export function reciprocalRankFusion<T extends string>(
  lists: Array<Array<T>>,
  k = 60,
): Array<{ id: T; score: number }> {
  const scores = new Map<T, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
