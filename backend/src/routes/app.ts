import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Which build of the app the shop should be running.
 *
 * The app asks this every time it opens. If the answer names a newer build it
 * shows the update prompt; the app allows "Later" a fixed number of times and
 * then stops letting anyone in until the new APK is installed. The count lives
 * on the handset — the shop's till must not depend on a round trip to be
 * usable — but the *policy* lives here, on the release row, so it can be
 * tightened for a release that matters without shipping a new app to say so.
 *
 * The check itself is unauthenticated. It has to be: the build that is too old
 * to be trusted is exactly the one that should not get as far as the login
 * screen, and there is nobody signed in at that point. It reveals only what
 * version of an APK is current, which is on the download page anyway.
 */
export const appRouter = Router();

const PLATFORMS = ['android', 'ios'] as const;

const checkQuery = z.object({
  platform: z.enum(PLATFORMS).default('android'),
  /** The installed `versionCode`. Absent from a build too old to send it. */
  build: z.coerce.number().int().min(0).optional(),
  /** For the log only; `build` is what is compared. */
  version: z.string().max(32).optional(),
});

/**
 * A version check is cheap, but it is also the one endpoint an app hits before
 * any credential exists, so it gets its own ceiling. Generous — an app on a
 * flaky connection retries — and per address, so a whole branch behind one
 * router still fits.
 */
const checkLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  clearOnSuccess: false,
  message: 'Too many version checks. Try again shortly.',
});

appRouter.get(
  '/version',
  checkLimit,
  asyncHandler(async (req, res) => {
    const q = checkQuery.parse(req.query);

    const latest = await prisma.appRelease.findFirst({
      where: { platform: q.platform, isActive: true },
      orderBy: { buildNumber: 'desc' },
    });

    // Nothing published yet. Answering "you are current" rather than 404 is
    // deliberate: a server with no release row must never lock a shop out of
    // its till, and the app treats a failed check the same way.
    if (!latest) {
      res.json({
        platform: q.platform,
        update_available: false,
        mandatory: false,
        grace_count: 0,
        current_build: q.build ?? null,
        latest: null,
      });
      return;
    }

    const installed = q.build ?? 0;
    const updateAvailable = installed < latest.buildNumber;

    // Compulsory two ways: the release says so, or the installed build is below
    // the floor it sets. The second is what covers a build that must not keep
    // running at all — a pricing bug, a broken sync — without waiting for the
    // shop to have tapped "Later" its allotted number of times.
    const mandatory = updateAvailable && (latest.mandatory || installed < latest.minimumBuild);

    res.json({
      platform: q.platform,
      update_available: updateAvailable,
      mandatory,
      /** How many times "Later" is allowed. Zero once the update is compulsory. */
      grace_count: mandatory ? 0 : latest.graceCount,
      current_build: q.build ?? null,
      latest: {
        version: latest.version,
        build: latest.buildNumber,
        minimum_build: latest.minimumBuild,
        download_url: latest.downloadUrl,
        notes: latest.notes,
        published_at: latest.publishedAt.toISOString(),
      },
    });
  })
);

/* ------------------------------------------------- publishing a new build */

const releasesRouter = Router();
releasesRouter.use(authenticate);

const releaseSchema = z.object({
  platform: z.enum(PLATFORMS).default('android'),
  version: z.string().min(1).max(32),
  build: z.number().int().min(1),
  /** Builds below this are locked out immediately. Defaults to no floor. */
  minimum_build: z.number().int().min(0).default(0),
  download_url: z.string().url(),
  notes: z.string().max(2000).default(''),
  grace_count: z.number().int().min(0).max(10).default(2),
  mandatory: z.boolean().default(false),
});

releasesRouter.get(
  '/',
  requireCapability('releases.publish'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ platform: z.enum(PLATFORMS).optional(), limit: z.coerce.number().min(1).max(50).default(20) })
      .parse(req.query);

    const rows = await prisma.appRelease.findMany({
      where: q.platform ? { platform: q.platform } : {},
      orderBy: [{ platform: 'asc' }, { buildNumber: 'desc' }],
      take: q.limit,
    });

    res.json(rows.map(serializeRelease));
  })
);

releasesRouter.post(
  '/',
  requireCapability('releases.publish'),
  asyncHandler(async (req, res) => {
    const body = releaseSchema.parse(req.body);
    const user = currentUser(req);

    if (body.minimum_build > body.build) {
      throw badRequest('The minimum build cannot be higher than the build being published.');
    }

    const existing = await prisma.appRelease.findUnique({
      where: { platform_buildNumber: { platform: body.platform, buildNumber: body.build } },
    });
    if (existing) {
      throw badRequest(
        `Build ${body.build} is already published as version ${existing.version}. Increase the versionCode and build again.`
      );
    }

    const release = await prisma.appRelease.create({
      data: {
        platform: body.platform,
        version: body.version,
        buildNumber: body.build,
        minimumBuild: body.minimum_build,
        downloadUrl: body.download_url,
        notes: body.notes,
        graceCount: body.grace_count,
        mandatory: body.mandatory,
        createdById: user.id,
        createdByName: user.fullName,
      },
    });

    res.status(201).json(serializeRelease(release));
  })
);

const releaseUpdateSchema = releaseSchema
  .omit({ platform: true, build: true })
  .partial()
  .extend({ is_active: z.boolean().optional() });

/**
 * Corrects a published release — a download link that was wrong, a grace count
 * that turned out to be too generous. The build number is not editable: it is
 * the identity of the APK sitting on people's phones.
 */
releasesRouter.put(
  '/:id',
  requireCapability('releases.publish'),
  asyncHandler(async (req, res) => {
    const body = releaseUpdateSchema.parse(req.body);

    const existing = await prisma.appRelease.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw notFound('Release not found.');

    const minimum = body.minimum_build ?? existing.minimumBuild;
    if (minimum > existing.buildNumber) {
      throw badRequest('The minimum build cannot be higher than the build itself.');
    }

    const release = await prisma.appRelease.update({
      where: { id: existing.id },
      data: {
        version: body.version,
        minimumBuild: body.minimum_build,
        downloadUrl: body.download_url,
        notes: body.notes,
        graceCount: body.grace_count,
        mandatory: body.mandatory,
        isActive: body.is_active,
      },
    });

    res.json(serializeRelease(release));
  })
);

appRouter.use('/releases', releasesRouter);

function serializeRelease(row: {
  id: string;
  platform: string;
  version: string;
  buildNumber: number;
  minimumBuild: number;
  downloadUrl: string;
  notes: string;
  graceCount: number;
  mandatory: boolean;
  isActive: boolean;
  publishedAt: Date;
  createdByName: string;
}) {
  return {
    id: row.id,
    platform: row.platform,
    version: row.version,
    build: row.buildNumber,
    minimum_build: row.minimumBuild,
    download_url: row.downloadUrl,
    notes: row.notes,
    grace_count: row.graceCount,
    mandatory: row.mandatory,
    is_active: row.isActive,
    published_at: row.publishedAt.toISOString(),
    published_by: row.createdByName,
  };
}
