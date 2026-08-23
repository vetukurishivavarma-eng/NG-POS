-- One-off fix for the update loop.
--
-- The 1.10.0 release was published as build 11, but the APK it points at
-- (ng-pos-1.10.0.apk) is actually versionCode 10. Every build-10 till was
-- therefore told to install the very APK it already has, forever.
--
-- This script makes build 10 the active 1.10.0 release (it already exists in
-- the table — the earlier P2002 error proved it), then withdraws the
-- mislabeled build 11. No rows are deleted. It is safe to run more than once:
-- every statement is guarded so a second run changes nothing.
--
-- If the build-10 row does not exist after all (different database?), the
-- first statement clones build 11 into a new build-10 row instead.
--
-- Run it from backend/ with the production connection string, then confirm
-- with:
--   curl "https://ngpos-api.onrender.com/api/app/version?platform=android&build=10"
-- which must answer "update_available": false.

-- 0. Identity check: the name printed must be the production database.
SELECT current_database() AS database_name,
       (SELECT count(*) FROM app_releases) AS release_rows;

-- 1. If no build-10 row exists, clone the mislabeled build-11 row into one.
INSERT INTO app_releases (id, platform, version, build_number, minimum_build,
                          download_url, notes, grace_count, mandatory, is_active,
                          published_at, created_by_id, created_by_name,
                          created_at, updated_at)
SELECT gen_random_uuid(), 'android', version, 10, 10,
       download_url, notes, grace_count, mandatory, true,
       published_at, created_by_id, created_by_name, now(), now()
FROM app_releases
WHERE platform = 'android' AND build_number = 11
  AND NOT EXISTS (SELECT 1 FROM app_releases WHERE platform = 'android' AND build_number = 10);

-- 2. Make the build-10 row the real 1.10.0 release: version, notes and link
--    from the build-11 row, floor at 10 so build-10 tills are not "below
--    minimum", still mandatory so older tills are pushed up to this APK.
UPDATE app_releases AS ten
   SET version = eleven.version,
       minimum_build = 10,
       mandatory = eleven.mandatory,
       is_active = true,
       download_url = eleven.download_url,
       notes = eleven.notes,
       updated_at = now()
  FROM app_releases AS eleven
 WHERE ten.platform = 'android' AND ten.build_number = 10
   AND eleven.platform = 'android' AND eleven.build_number = 11;

-- 3. Withdraw the mislabeled build-11 release. Once this is active=false the
--    updater can never offer it again.
UPDATE app_releases
   SET is_active = false, updated_at = now()
 WHERE platform = 'android' AND build_number = 11 AND is_active = true;

-- 4. What the table looks like now (highest build wins for the updater).
SELECT platform, version, build_number, minimum_build, mandatory, is_active, download_url
  FROM app_releases
 ORDER BY platform, build_number DESC;
