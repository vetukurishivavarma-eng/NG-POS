-- The two columns the shops' own stock sheet carries and the catalogue did not:
-- the active ingredient, and the date the line expires.
--
-- Both nullable with no default: a catalogue of 435 products has neither filled
-- in yet, and a backfilled placeholder would read at the counter as a fact.
ALTER TABLE "products" ADD COLUMN "chemical_name" TEXT;
ALTER TABLE "products" ADD COLUMN "expiry_date" DATE;
