CREATE TABLE "wa_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"status" text NOT NULL,
	"category" text NOT NULL,
	"header_type" text,
	"header_text" text,
	"body_text" text DEFAULT '' NOT NULL,
	"footer_text" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_templates_name_language_uq" ON "wa_templates" USING btree ("name","language");