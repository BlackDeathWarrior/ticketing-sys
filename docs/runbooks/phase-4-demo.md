# Phase 4 demo checklist: knowledge base

Prerequisites: `pnpm docker:up && pnpm sample:load`. The loader uploads fictional Demo Store policies:

- returns, shipping and billing (Markdown);
- account help (HTML);
- three Hindi FAQ entries;
- an internal escalation playbook;
- one unapproved draft.

It indexes them with the scripted demo embeddings and approves all but the draft.

## Search with citations

1. Sign in to Orbit Desk (http://localhost:8081) as `jonah.reyes@tms.example` (agent, password `Sample-Passw0rd!`) and open **Knowledge base** in the sidebar.
   - The documents list shows approved documents only; there is no "Add document".
2. Search "when will my refund reach my card".
   - Results show the document, the section (for example "Refund timing"), a snippet, the similarity, and "Open source", which opens the uploaded file.
3. Search in Hindi: "रिफंड कब आएगा". The Hindi FAQ answers.

## Add, review and index

1. Sign in as `priya.natarajan@tms.example` (supervisor) and open **Knowledge base**.
2. **Add document** → **Upload a file** → pick a PDF, Word or Markdown file → **Add as draft**. The row shows "Draft" and "Waiting to index", then "Indexed · N chunks".
   - For Markdown and HTML without a title, the title becomes the document's first heading.
3. Search for something in it: nothing is found while it is a draft.
4. **Approve** it and search again: it is found.
5. **Add document** → **FAQ entry**, visible to "Public". Approve it and search for it.
6. **Archive** a document: it leaves search results but stays listed, dimmed.

## In a ticket

Open any ticket's drawer. The **Knowledge base** panel is prefilled with the subject.

- Search, then **Insert in reply** on a public result. The composer gets the passage followed by "(Source: …)".
- Internal results are labelled and can't be inserted.

## Behind the scenes

- **Audit:** `GET /api/v1/audit?action=kb.document_indexed` shows each indexing run as `system`, with chunk count and mode.
- **Keyword fallback:** in Settings, turn off the "Scripted embeddings" model and reindex a document. It becomes "Keyword search only", and search still works by keywords.
- **Changing the embedding model:** change the "Knowledge base embeddings" role in Settings. Every document re-indexes.
- **Quality:** `pnpm kb:eval` prints recall@5 for the labelled questions. With the demo embeddings it is 1.00; add a real embedding model in Settings to measure real retrieval.
