-- A released device must be able to sign in again.
--
-- Revoked rows are kept as history, so the unique constraint on
-- (user_id, device_id) was claimed by the removed session forever: the next
-- sign-in on that handset hit the constraint, surfaced as 409, and looked
-- exactly like "this account is signed in on another device". The phone was
-- barred from the account permanently.
--
-- One live claim per device is enforced in claimDevice() against
-- revoked_at IS NULL instead, which is the condition that actually matters.
DROP INDEX IF EXISTS "device_sessions_user_id_device_id_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "device_sessions_user_id_device_id_idx" ON "device_sessions"("user_id", "device_id");
