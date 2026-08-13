-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "store_id" TEXT,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_label" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "before" JSONB,
    "after" JSONB,
    "actor_id" TEXT,
    "actor_name" TEXT NOT NULL DEFAULT '',
    "actor_role" TEXT NOT NULL DEFAULT '',
    "device_id" TEXT,
    "device_name" TEXT,
    "ip" TEXT,
    "route" TEXT NOT NULL DEFAULT '',
    "minor" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_releases" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "version" TEXT NOT NULL,
    "build_number" INTEGER NOT NULL,
    "minimum_build" INTEGER NOT NULL DEFAULT 0,
    "download_url" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "grace_count" INTEGER NOT NULL DEFAULT 2,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT,
    "created_by_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_entity_created_at_idx" ON "audit_logs"("organization_id", "entity", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_created_at_idx" ON "audit_logs"("entity", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_store_id_created_at_idx" ON "audit_logs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "app_releases_platform_is_active_build_number_idx" ON "app_releases"("platform", "is_active", "build_number");

-- CreateIndex
CREATE UNIQUE INDEX "app_releases_platform_build_number_key" ON "app_releases"("platform", "build_number");

