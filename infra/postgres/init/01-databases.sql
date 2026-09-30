-- Runs once, when the Postgres volume is first created.
-- LiteLLM keeps its own schema in a separate database.
CREATE DATABASE litellm OWNER tms;

\connect tms
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
