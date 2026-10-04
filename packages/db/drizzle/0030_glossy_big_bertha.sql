CREATE TABLE "phone_agent_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"provider_tool_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "phone_agent_tools_key_idx" ON "phone_agent_tools" USING btree ("provider","key");