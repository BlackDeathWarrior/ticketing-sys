# ADR 0033: Knowledge-base connectors

Status: accepted (2026-10-03).

## Context

The knowledge base took files, text, FAQ entries and single web pages, each added by a person. A company's answers usually already live somewhere else: a help site, a handbook in a repository, Notion, a shared drive, a bucket, a NAS share or a table in its own database. Copying them by hand goes stale the day after.

## Decision

- **Connectors** (`kb_connectors`, `apps/api/src/kb/connectors`): a named source of one type with its settings, who may see what it brings in (public, internal or one team), whether it approves its own documents, and how often it syncs (0 = only when someone asks). Types, each talking to the source's own API: website or sitemap (same-site links followed from a start page, or every address in a sitemap, at most 300 pages, optionally under one path), GitHub repository (the trees and contents APIs; a token only for private repositories), Notion (search and blocks, with an integration token), Google Drive folder (a service account, signed JWT, Google Docs exported as text), S3-compatible bucket (`@aws-sdk/client-s3`, any endpoint), shared folder (a NAS share mounted on the worker), and PostgreSQL or MySQL (one query, a row per document; `pg` and `mysql2`).
- **Credentials** are secrets `kb.connector-<id>.<field>` (`KB_CONNECTOR_SECRETS`), written once and never returned; saving them needs `settings:secrets` as well as `kb:manage` (ADR 0009). Removing a connector removes its secrets.
- **Sync** runs in the worker on the `kb-sync` queue, one at a time; a sweep every five minutes queues the connectors that are due, and "Sync now" is the outbox event `kb.connector_sync_requested`. A sync lists the source (at most 500 items), fetches only items whose version (modified time, ETag, commit sha) changed, and compares the text's hash: a new item becomes a document (`kb_documents.connector_id`, `external_id`), a changed one a new version that is indexed again by the usual pipeline, an unchanged one is left alone. Items gone from the source are archived, never deleted, and only after a complete listing. What a connector brings in is a draft unless it approves its own (ADR 0010: only approved documents are searched). The run's outcome (`status`, `stats`, `last_error`) is a progress record like a document's index state and is not audited; creating, changing, removing and asking for a sync are.
- **Safety.** Website, GitHub, Notion and Drive addresses must be public (`assertPublicUrl`) unless the host is listed in `KB_CONNECTOR_PRIVATE_HOSTS`, which is also needed for an S3 endpoint or database on a private network. A folder must resolve (after links) inside one of `KB_CONNECTOR_PATHS`; with none set, folders are off. A database query is one `SELECT`, run in a read-only transaction with a statement timeout and a row limit, on a connection string the admin supplies.
- **Console.** Knowledge base → Sources (for `kb:manage`): add, edit, test (lists the source once and changes nothing), sync now, pause and remove; each document names the source that keeps it in sync. Removing a connector keeps its documents as ordinary ones.

## Consequences

- Nothing here is simulated: Notion and Google Drive work only with real keys, GitHub without a key only for public repositories, and a NAS is a mounted path (no SMB or NFS client in the worker).
- A source that approves its own documents puts its text in front of customers when it is public; the option says so and is off by default.
- A large source is capped at 500 items per connector; split it by path or prefix.
- Not built: databases other than PostgreSQL and MySQL, per-item permissions copied from the source, webhooks from sources (syncs are scheduled or asked for).
