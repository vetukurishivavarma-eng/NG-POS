-- Retire the standalone Warehouse model.
--
-- The organisation's warehouse is a Store with staff_full_access = true — that
-- is the row transfers, the till and the capability system all use. The
-- separate `warehouses` / `warehouse_stock` tables were never wired to any of
-- them and only misled anyone who found the (now removed) "Warehouses" screen.
--
-- The tables are RENAMED, not dropped: whatever a client entered under the old
-- screen is kept verbatim and can be inspected or promoted into a real
-- Store + inventory later (see prisma/convertRetiredWarehouses.ts). Prisma no
-- longer manages these tables once the models are gone.

ALTER TABLE "warehouse_stock" RENAME TO "warehouse_stock_retired";
ALTER TABLE "warehouses" RENAME TO "warehouses_retired";
