-- One-off: a temporary ORG_ADMIN account so a release can be published from the
-- app's "App Releases" screen (More -> App Releases, releases.publish capability)
-- without needing an existing admin's password. Safe to deactivate or delete once
-- the release is published -- see the follow-up conversation for when to do so.
insert into users (id, organization_id, email, password_hash, full_name, role, assigned_stores, is_active)
values (
    gen_random_uuid(),
    '870dc2c6-46b2-4f20-a3a9-da231072d439',
    'temp-release-admin@ngpos.local',
    '$2a$10$aXVUmlY2SRfbsSnr13hNEeOZigVZ4CLVgzDBS8TvR43R/carn4kO6',
    'Temp Release Admin',
    'ORG_ADMIN',
    array[]::text[],
    true
);
