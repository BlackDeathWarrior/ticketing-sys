-- The audit trail is append-only: reject any UPDATE or DELETE on audit_log.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
