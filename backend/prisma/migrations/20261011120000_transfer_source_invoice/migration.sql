-- A transfer loaded from a supplier delivery points back at that invoice, so
-- the invoice can be left out of the "From an invoice" picker once it has been
-- sent on. Nullable: older transfers carry no link.
ALTER TABLE "transfers" ADD COLUMN "source_invoice_id" TEXT;

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_source_invoice_id_fkey"
  FOREIGN KEY ("source_invoice_id") REFERENCES "supplier_invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "transfers_source_invoice_id_idx" ON "transfers"("source_invoice_id");

-- Backfill: link transfers made before this column existed to the delivery
-- they were most likely loaded from. Heuristic, deliberately strict:
--   * sent FROM the shop the delivery landed in, within 7 days after it;
--   * every transfer line is a product on that invoice, at no more than the
--     invoice quantity;
--   * a single-line transfer must move exactly the invoice quantity (otherwise
--     any one-product transfer would match any delivery of that product);
--   * the nearest such delivery before the transfer wins.
-- A wrong match only hides an invoice from the "From an invoice" picker; the
-- invoice screen's "Transfer This Stock" still opens it.
UPDATE "transfers" AS t
SET "source_invoice_id" = m.invoice_id
FROM (
  SELECT DISTINCT ON (tr.id) tr.id AS transfer_id, i.id AS invoice_id
  FROM "transfers" tr
  JOIN "supplier_invoices" i
    ON i.organization_id = tr.organization_id
   AND i.store_id = tr.from_store_id
   AND i.created_at <= tr.created_at
   AND tr.created_at < i.created_at + INTERVAL '7 days'
  WHERE tr.source_invoice_id IS NULL
    AND tr.status <> 'cancelled'
    AND NOT EXISTS (
      SELECT 1 FROM "transfer_items" ti
      WHERE ti.transfer_id = tr.id
        AND NOT EXISTS (
          SELECT 1 FROM "supplier_invoice_items" ii
          WHERE ii.invoice_id = i.id AND ii.product_id = ti.product_id AND ti.quantity <= ii.quantity
        )
    )
    AND (
      (SELECT count(*) FROM "transfer_items" ti WHERE ti.transfer_id = tr.id) > 1
      OR EXISTS (
        SELECT 1 FROM "transfer_items" ti
        JOIN "supplier_invoice_items" ii ON ii.invoice_id = i.id AND ii.product_id = ti.product_id
        WHERE ti.transfer_id = tr.id AND ti.quantity = ii.quantity
      )
    )
  ORDER BY tr.id, i.created_at DESC
) AS m
WHERE t.id = m.transfer_id;
