ALTER TABLE "tickets" ADD COLUMN "ai_closure" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reason" text;--> statement-breakpoint
-- A customer who writes again after the AI resolved their ticket gets the AI again.
-- Added only to a workflow that has both statuses and does not have the transition yet.
INSERT INTO "workflow_transitions" ("from_status", "to_status")
SELECT 'resolved', 'ai_handling'
WHERE EXISTS (SELECT 1 FROM "ticket_statuses" WHERE "key" = 'resolved')
  AND EXISTS (SELECT 1 FROM "ticket_statuses" WHERE "key" = 'ai_handling')
ON CONFLICT DO NOTHING;
