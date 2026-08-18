-- Inbound transport per unit, split out of the buying price.
--
-- Default 0, not null: every existing row's cost_price is already the landed
-- figure (the importer preferred the price master's "Landing" column over its
-- bare "COST"), so a transport of zero keeps that landed cost exactly where it
-- is and simply says the split is not yet recorded.
ALTER TABLE "products" ADD COLUMN "transport_cost" DECIMAL(12,2) NOT NULL DEFAULT 0;
