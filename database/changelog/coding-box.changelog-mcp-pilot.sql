-- liquibase formatted sql

-- changeset iqb:mcp-pilot-operations
-- comment: Person-bound idempotent MCP pilot imports and autocoding operations
CREATE TABLE "public"."mcp_pilot_operation" (
  "id" UUID PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL REFERENCES "public"."workspace"("id") ON DELETE CASCADE,
  "actor_id" INTEGER NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "kind" VARCHAR(32) NOT NULL CHECK ("kind" IN ('testcenter-import', 'autocoding')),
  "request_key" VARCHAR(120) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'needs_attention')),
  "credential" TEXT,
  "credential_expires_at" TIMESTAMPTZ,
  "external_job_id" VARCHAR(128),
  "statistics" JSONB,
  "error_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_pilot_request_unique" UNIQUE ("workspace_id", "actor_id", "kind", "request_key")
);
CREATE UNIQUE INDEX "mcp_pilot_active_workspace" ON "public"."mcp_pilot_operation" ("workspace_id")
  WHERE "status" IN ('queued', 'running');

-- rollback DROP TABLE "public"."mcp_pilot_operation";
