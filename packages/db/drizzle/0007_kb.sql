CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"section" text,
	"content" text NOT NULL,
	"tokens" integer NOT NULL,
	"embedding" vector(1024),
	"embedding_model_id" uuid,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(section, '') || ' ' || content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"team_id" uuid,
	"language" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"index_state" text DEFAULT 'pending' NOT NULL,
	"index_error" text,
	"index_mode" text,
	"version" integer DEFAULT 1 NOT NULL,
	"indexed_version" integer,
	"content" text,
	"content_hash" text,
	"url" text,
	"s3_key" text,
	"filename" text,
	"content_type" text,
	"size_bytes" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_embedding_model_id_llm_models_id_fk" FOREIGN KEY ("embedding_model_id") REFERENCES "public"."llm_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_chunks_embedding_hnsw" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_chunks_tsv_gin" ON "kb_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "kb_documents_status_idx" ON "kb_documents" USING btree ("status","index_state");--> statement-breakpoint
CREATE INDEX "kb_documents_title_trgm" ON "kb_documents" USING gin ("title" gin_trgm_ops);