-- Wake the outbox relay as soon as events commit, instead of waiting for its
-- next poll. NOTIFY is delivered at commit, once per statement.
CREATE OR REPLACE FUNCTION outbox_events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox_events', '');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_notify
  AFTER INSERT ON outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION outbox_events_notify();
