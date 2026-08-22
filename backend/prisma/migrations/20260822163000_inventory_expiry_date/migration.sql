-- A shop's own expiry for the batch it's carrying, distinct from
-- products.expiry_date (the master default a shop with none entered falls
-- back to). Different shops can be selling different batches of the same
-- product, so this lives on inventory (store, product), not on products.
--
-- Nullable with no default, same reasoning as products.expiry_date: nothing
-- has been entered for the existing catalogue and a backfilled placeholder
-- would read at the counter as a fact.
ALTER TABLE "inventory" ADD COLUMN "expiry_date" DATE;
