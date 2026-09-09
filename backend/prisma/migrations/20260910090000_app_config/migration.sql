-- Server-controlled app settings. One row today: `demo_trial`, the kill switch
-- for the brand-free demo build (endsAt + revoked), set from the super-admin
-- trial-control screen. The row is created lazily on first read.
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);
