CREATE TABLE "customer_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"pattern" text,
	"ticket_id" uuid,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	"clear_note" text
);
--> statement-breakpoint
ALTER TABLE "customer_flags" ADD CONSTRAINT "customer_flags_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_flags_customer_idx" ON "customer_flags" USING btree ("customer_id","created_at");--> statement-breakpoint
-- The AI ends a conversation for misuse without calling it solved.
-- Added only to a workflow that has both statuses and does not have the transition yet.
INSERT INTO "workflow_transitions" ("from_status", "to_status")
SELECT 'ai_handling', 'closed'
WHERE EXISTS (SELECT 1 FROM "ticket_statuses" WHERE "key" = 'ai_handling')
  AND EXISTS (SELECT 1 FROM "ticket_statuses" WHERE "key" = 'closed')
ON CONFLICT DO NOTHING;
