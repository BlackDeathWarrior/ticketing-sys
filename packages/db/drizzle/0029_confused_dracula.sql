ALTER TABLE "voice_calls" ADD COLUMN "provider" text;--> statement-breakpoint
UPDATE "voice_calls" SET "provider" = 'sarvam' WHERE "transport" = 'phone';
