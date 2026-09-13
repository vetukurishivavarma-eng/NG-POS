-- One-off: a temporary ORG_ADMIN account so a release can be published from the
-- app's "App Releases" screen (More -> App Releases, releases.publish capability)
-- without needing an existing admin's password. Safe to deactivate or delete once
-- the release is published -- see the follow-up conversation for when to do so.
--
-- (Retried after a first attempt failed on a missing updated_at -- see
-- render.yaml's startCommand history around 2026-09-14 for the recovery step.)
insert into users (id, organization_id, email, password_hash, full_name, role, assigned_stores, is_active, created_at, updated_at)
values (
    gen_random_uuid(),
    '870dc2c6-46b2-4f20-a3a9-da231072d439',
    'temp-release-admin@ngpos.local',
    '$2a$10$tqpxnUIgx4pSNBnWdv28zu/BPVPlPRCE8GRjs5Yna7qg8Bjco9NPm',
    'Temp Release Admin',
    'ORG_ADMIN',
    array[]::text[],
    true,
    now(),
    now()
)
on conflict (email) do nothing;
