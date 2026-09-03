-- "Pass on" transfers: a shop receives stock on one transfer and then
-- distributes it onward with another. The onward transfer points back at the
-- one it came from so the paperwork shows the chain.
--
-- Nullable, no default: every existing transfer stands on its own.
ALTER TABLE "transfers" ADD COLUMN "source_transfer_id" TEXT;

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_source_transfer_id_fkey"
  FOREIGN KEY ("source_transfer_id") REFERENCES "transfers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "transfers_source_transfer_id_idx" ON "transfers"("source_transfer_id");
