# ADR 0010: Knowledge base on pgvector, with hybrid search and a pinned embedding model

Status: accepted (2026-09-30)

## Context

The AI agent (Phase 5) and human agents need answers from company documents (policies, FAQs, help pages) with citations. There are three constraints:

- Customer-facing answers must only use documents that are approved and public.
- Providers vary, and the admin picks the cheapest model per role (ADR 0008).
- Hindi and English content sit side by side.

## Decision

**Storage**

- Documents live in `kb_documents` and chunks in `kb_chunks`, in the same Postgres.
- Chunks carry a pgvector `vector(1024)` column with an HNSW cosine index, and a generated `tsvector` built with the `simple` configuration (no stemming, so it behaves the same for every language) with a GIN index.
- Migration `0006_pgvector` runs `CREATE EXTENSION vector`. The pgvector image and Amazon RDS for PostgreSQL 16 both support it.

**Sources**

- Uploaded files are stored in S3 (`kb/<id>/v<version>/<file>`): PDF (pdf-parse), DOCX (mammoth, converted to HTML), HTML (html-to-text), Markdown and plain text.
- Also supported: web pages, FAQ entries (the question is the title) and free text.
- Extracted text keeps headings as `#` lines.

**Review and visibility**

- Every document starts as `draft`. Only `approved` documents are searched; `archived` ones are kept but never used. Only `kb:manage` (supervisors and admins) can approve.
- Visibility:
  - `public`: the AI may quote it to customers;
  - `internal`: agents only;
  - `team`: members of one team.
- Search with `audience=customer` keeps to public documents. That is what the AI agent will use when it answers customers.

**Indexing (worker)**

- Every document change emits `kb.document_changed`. A handler enqueues a job on the BullMQ `kb-ingest` queue, de-duplicated per document version, with bounded concurrency (`KB_INGEST_CONCURRENCY`).
- A job:
  1. extracts the text;
  2. chunks it by heading (about 600 tokens, about 80 tokens of overlap, each chunk labelled with its heading trail);
  3. embeds it through the **pinned** `embedding` role at 1024 dimensions;
  4. swaps the chunks in one transaction.
- The finished result (`kb.document_indexed`, or `kb.document_index_failed` after 3 attempts) is audited and published. The transient `indexing` marker is a progress field, not a reviewable change, so it has no audit row.
- **Changing the embedding role re-indexes everything**, because vectors from different models can't be compared.
- Without a usable embedding model, or with one that won't return 1024 dimensions, documents are indexed for **keyword search only** and say so. Search degrades the same way.

**Search**

- Vector candidates (cosine) and keyword candidates (`to_tsquery` over the query's meaningful words, OR'ed, ranked with `ts_rank_cd`) are fused with reciprocal rank fusion (k = 60).
- Hits return the section, a snippet around the first matching word, the cosine similarity (a later input to AI confidence), what matched it, and a citation: the source URL or the document's download route.

**URL sources**

- Fetched by the worker, not in the request.
- Only http and https. Private, loopback, link-local and metadata addresses are refused, each redirect hop is checked again, and pages are capped at 5 MB with a 15-second timeout.
- `KB_ALLOW_PRIVATE_URLS=true` exists for local demos only.

**Dimensions**

1024 is fixed because the providers the admin uses can all produce it:

- OpenAI `text-embedding-3-*` with `dimensions`;
- Mistral embed (native 1024);
- Gemini with output dimensionality;
- NVIDIA NIM e5-style models.

Moving to another size is a migration plus a re-index.

## Consequences

- One database: no separate vector store to run, back up or pay for on AWS.
- Recall is measured, not guessed:
  - `apps/api/test/kb.int.test.ts` runs the labelled questions in `scripts/sample-data/kb/eval.json` and requires recall@5 ≥ 0.8;
  - `pnpm kb:eval` runs the same check against a live stack and whatever embedding model is configured.
- The fake embeddings (hashed bag of words) measure the pipeline, not semantic quality. Rankings with a real model differ, so the E2E specs only require results in the top five.
- HNSW with post-filtering can return fewer candidates when most chunks are filtered out. For large knowledge bases, tune `hnsw.ef_search` or partition by visibility.
