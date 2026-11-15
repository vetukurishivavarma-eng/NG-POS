-- TEMPORARY test login for the owner: a shop-staff (STORE_MANAGER) account, to
-- check what staff can and cannot do (no Revoke, no reports). Delete or
-- deactivate it (More -> Staff) once testing is done.
insert into users (id, organization_id, email, password_hash, full_name, role, assigned_stores, is_active, created_at, updated_at)
values (
    gen_random_uuid(),
    '870dc2c6-46b2-4f20-a3a9-da231072d439',
    'temp-test-staff@ngpos.local',
    '$2a$10$r61CGoUW/NGJOTkrzaTfX.QGAez1SVBL2vhlQzBlLuPYBHeJxpnBm',
    'Temp Test Staff',
    'STORE_MANAGER',
    array[]::text[],
    true,
    now(),
    now()
)
on conflict (email) do nothing;
