-- Permissions now depend on where someone works, not only on their role.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "staff_product_add_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "staff_full_access" BOOLEAN NOT NULL DEFAULT false;

-- Lusaka is the organisation's warehouse. Its staff run the business rather
-- than a till, so they get the whole operational set whatever their role.
-- Matched on the natural key rather than an id, which differs per environment.
UPDATE "stores" SET "staff_full_access" = true WHERE "code" = 'LUSAKA001';

-- Shop staff may add products for two months from this migration, which is the
-- window for getting the catalogue in. Existing rows only: a later organisation
-- starts with no limit rather than one that expired before it was created.
UPDATE "organizations"
   SET "staff_product_add_until" = now() + interval '2 months'
 WHERE "staff_product_add_until" IS NULL;
