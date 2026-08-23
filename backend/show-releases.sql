-- Read-only: shows every published release so we can see the real state of
-- the app_releases table before fixing the update loop. Changes nothing.
SELECT platform,
       version,
       build_number,
       minimum_build,
       mandatory,
       grace_count,
       is_active,
       published_at,
       created_by_name,
       download_url
  FROM app_releases
 ORDER BY platform, build_number DESC;
