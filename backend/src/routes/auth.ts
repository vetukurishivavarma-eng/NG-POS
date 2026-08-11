import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { env, passwordResetConfigured } from '../env.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, signToken } from '../middleware/auth.js';
import { serializeDevice, serializeUser } from '../lib/serialize.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { sendMail } from '../lib/mailer.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { revokeOwnSession } from './devices.js';

export const authRouter = Router();

/**
 * Shop tills sit on shared connections, so limiting by IP alone would lock out
 * a whole branch when one person fat-fingers a password. Keyed by IP *and*
 * address: guessing one account's password is what we're stopping.
 */
const loginLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 8,
  key: (req) => `${req.ip}|${String((req.body as { email?: string })?.email ?? '').toLowerCase()}`,
  message: 'Too many sign-in attempts. Wait a few minutes and try again.',
});

/** Registration creates a whole tenant; one a minute per address is generous. */
const registerLimiter = rateLimit({ windowMs: 60_000, max: 3 });

/**
 * Optional so a browser or a support script can still sign in; when it is
 * absent the session is recorded as an unnamed device rather than escaping the
 * one-device rule, which is what makes the rule worth having.
 */
const deviceSchema = z
  .object({
    device_id: z.string().min(6).max(128).optional(),
    device_name: z.string().max(120).optional(),
    platform: z.string().max(40).optional(),
    app_version: z.string().max(40).optional(),
  })
  .optional();

/**
 * Marks a session opened by a client that identified no device.
 *
 * The distinction earns its keep. Such a session is still subject to the
 * one-device rule — a script cannot sign in behind a till's back — but it never
 * *enforces* it, and a real device signing in revokes it. Without that
 * asymmetry a single stray API login wedges the account shut: freeing a device
 * requires an administrator to sign in, and the administrator is precisely who
 * cannot. That is not hypothetical; it happened on the first live test run.
 */
const UNIDENTIFIED_PREFIX = 'unidentified-';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  device: deviceSchema,
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, device } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Same message and comparable timing whether the address is unknown or the
    // password is wrong, so the endpoint can't be used to enumerate accounts.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) throw unauthorized('Incorrect email or password.');
    if (!user.isActive) throw unauthorized('This account has been deactivated.');

    const session = await claimDevice(user, device, req.ip ?? null);

    res.json({
      access_token: signToken(user.id, user.organizationId, session.id),
      token_type: 'bearer',
      user: serializeUser(user),
      device: serializeDevice(session),
    });
  })
);

/**
 * Binds this sign-in to one device, or refuses it.
 *
 * Signing in again on the device that already holds the account is always
 * allowed — a token expiring, an app restart or a reinstall must not need an
 * administrator. What is refused is a *second* device while the first is still
 * active, which is the case the rule exists for: one set of credentials being
 * passed around a counter.
 */
async function claimDevice(
  user: { id: string; organizationId: string },
  device: { device_id?: string; device_name?: string; platform?: string; app_version?: string } | undefined,
  ip: string | null
) {
  // A client that sends no id gets a fresh one each time, so it cannot hold a
  // stable claim. See UNIDENTIFIED_PREFIX for why it also cannot block one.
  const identified = device?.device_id != null;
  const deviceId = device?.device_id ?? `${UNIDENTIFIED_PREFIX}${randomUUID()}`;
  const deviceName = device?.device_name?.trim() || 'Unnamed device';
  const platform = device?.platform ?? 'unknown';

  const active = await prisma.deviceSession.findMany({
    where: { userId: user.id, revokedAt: null },
  });

  const mine = active.find((s) => s.deviceId === deviceId);
  if (mine) {
    return prisma.deviceSession.update({
      where: { id: mine.id },
      data: {
        lastSeenAt: new Date(),
        lastIp: ip,
        deviceName,
        platform,
        appVersion: device?.app_version ?? null,
      },
    });
  }

  // Only a real till may stand in the way of another real till. A session
  // opened by something that sent no device id — a support script, a curl
  // check, a browser — is held to the rule but never enforces it.
  const blocking = active.find((s) => !s.deviceId.startsWith(UNIDENTIFIED_PREFIX));
  if (blocking) {
    // 409, not 401: the credentials were right. Telling them which device holds
    // the account is the whole point — it is how the person works out whether
    // it is their own old phone or somebody else using their password.
    throw conflict(
      `This account is already signed in on ${blocking.deviceName}. Ask your administrator to remove that device, or reset your password to release it.`,
      'DEVICE_ALREADY_ACTIVE'
    );
  }

  if (identified) {
    // A phone signing in displaces any scripted sessions outright. This is what
    // stops a stray automated login from locking a shop out of its own till —
    // the deadlock is real, because releasing a device needs an admin to sign
    // in, and the admin is the one who cannot.
    const stale = active.filter((s) => s.deviceId.startsWith(UNIDENTIFIED_PREFIX));
    if (stale.length > 0) {
      await prisma.deviceSession.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { revokedAt: new Date(), revokedReason: 'Replaced by a registered device' },
      });
    }
  }

  return prisma.deviceSession.create({
    data: {
      userId: user.id,
      organizationId: user.organizationId,
      deviceId,
      deviceName,
      platform,
      appVersion: device?.app_version ?? null,
      lastIp: ip,
    },
  });
}

const registerSchema = z.object({
  organization_name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens only.'),
  full_name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  device: deviceSchema,
});

/**
 * Creates an organisation and its first administrator. Self-service signup for
 * a new tenant; adding staff to an existing organisation goes through
 * `POST /users` instead.
 */
authRouter.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const email = body.email.toLowerCase();

    if (await prisma.user.findUnique({ where: { email } })) {
      throw badRequest('That email is already registered.');
    }

    const user = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: body.organization_name, slug: body.slug },
      });

      return tx.user.create({
        data: {
          organizationId: org.id,
          email,
          passwordHash: await bcrypt.hash(body.password, 10),
          fullName: body.full_name,
          role: 'ORG_ADMIN',
        },
      });
    });

    // Registration binds the device it was performed on, like any sign-in —
    // otherwise the very first account in an organisation would hold a token
    // attached to no device and outside the rule.
    const session = await claimDevice(user, body.device, req.ip ?? null);

    res.status(201).json({
      access_token: signToken(user.id, user.organizationId, session.id),
      token_type: 'bearer',
      user: serializeUser(user),
      device: serializeDevice(session),
    });
  })
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(
      serializeUser({
        id: user.id,
        organizationId: user.organizationId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        assignedStores: user.assignedStores,
        isActive: true,
      })
    );
  })
);

/**
 * Sign out, and release the device.
 *
 * Under the one-device rule this is not a convenience — it is how a person
 * hands a shared handset to the next shift without an administrator. Idempotent
 * so an app retrying on a bad connection cannot fail on the second attempt.
 */
authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.session) await revokeOwnSession(req.session.id);
    res.json({ detail: 'Signed out. This device has been released.' });
  })
);

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'Password must be at least 8 characters.'),
});

authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = passwordSchema.parse(req.body);
    const me = currentUser(req);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await bcrypt.compare(body.current_password, user.passwordHash))) {
      throw unauthorized('Your current password is incorrect.');
    }

    await prisma.user.update({
      where: { id: me.id },
      data: {
        passwordHash: await bcrypt.hash(body.new_password, 10),
        passwordChangedAt: new Date(),
      },
    });

    // Every *other* device is released, this one deliberately kept: changing
    // your own password must not lock you out of the handset in your hand, and
    // under the one-device rule a self-inflicted lockout would need an admin to
    // undo.
    const keep = req.session?.id;
    await prisma.deviceSession.updateMany({
      where: { userId: me.id, revokedAt: null, ...(keep ? { NOT: { id: keep } } : {}) },
      data: { revokedAt: new Date(), revokedReason: 'Password changed' },
    });

    // Hand this device a fresh token so the person who *made* the change isn't
    // logged out by their own action.
    res.json({
      detail: 'Password updated.',
      ...(keep
        ? { access_token: signToken(me.id, me.organizationId, keep), token_type: 'bearer' }
        : {}),
    });
  })
);

/* ------------------------------------------------------------------ *
 * Forgotten passwords
 *
 * A shop's staff accounts are internal (`cashier@ngpos.local`) and no mailbox
 * answers them, so the usual "click the link we mailed you" flow has nowhere to
 * send anything. Instead the request goes to one configured administrator, who
 * knows the staff and can see who is asking, and who reads the one-time code
 * back to them. That also means a stolen staff address alone gets an attacker
 * nothing — a second, human, out-of-band step stands in the way.
 * ------------------------------------------------------------------ */

/** Deliberately no I/O/0/1 — this gets read aloud in a noisy shop. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
/** Wrong guesses before the code is burned. */
const MAX_RESET_ATTEMPTS = 5;

function generateResetCode(): string {
  let code = '';
  // randomInt is CSPRNG-backed and rejection-samples, so no modulo bias.
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * One request a minute, twelve an hour, per address and per IP. Enough for a
 * staff member who mistypes, nowhere near enough to use the endpoint as a way
 * to spam the administrator's inbox.
 */
const forgotLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 12,
  key: (req) => `forgot|${req.ip}|${String((req.body as { email?: string })?.email ?? '').toLowerCase()}`,
  message: 'Too many reset requests. Try again later, or ask your administrator directly.',
  /** Unlike sign-in, a success must still count — otherwise it is a free mail relay. */
  clearOnSuccess: false,
});

/** Guessing an 8-character code needs far more than this many tries. */
const resetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  key: (req) => `reset|${req.ip}|${String((req.body as { email?: string })?.email ?? '').toLowerCase()}`,
  message: 'Too many attempts. Ask your administrator for a new code.',
});

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post(
  '/forgot-password',
  forgotLimiter,
  asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);

    // Only real configuration failure is worth a distinct answer — it tells an
    // operator the feature is off, and reveals nothing about any account.
    if (!passwordResetConfigured) {
      throw badRequest(
        'Password reset by email is not set up on this server. Ask your administrator to reset it for you.',
        'RESET_NOT_CONFIGURED'
      );
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // This endpoint used to answer identically for a real address, an unknown
    // one, and a deactivated account, so it could not be used to enumerate
    // staff. That protection is deliberately given up here: these are internal
    // shop accounts on addresses no public mailbox answers, and sending someone
    // to a code screen for an address that can never produce a code wastes a
    // trip to the administrator. The endpoint is still rate limited by IP and
    // address, which is what keeps bulk probing impractical.
    if (!user) {
      throw notFound('No account exists for that email address.');
    }
    if (!user.isActive) {
      throw badRequest(
        'That account has been deactivated. Ask your administrator to reactivate it.',
        'ACCOUNT_INACTIVE'
      );
    }

    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);

    await prisma.$transaction(async (tx) => {
      // Only the newest code should ever work, or an old mail stays live.
      await tx.passwordResetRequest.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.passwordResetRequest.create({
        data: {
          userId: user.id,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt,
          requestIp: req.ip ?? '',
        },
      });
    });

    const when = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: env.REPORT_TIMEZONE,
    }).format(new Date());

    // Deliberately not awaited: the app gives up after 20 seconds (mobile
    // client.ts), while a mail round trip against a host that drops SMTP takes
    // minutes. The send runs behind the response and its outcome is logged.
    //
    // (The timing-oracle reason for this is gone now that the answers above
    // differ openly, but the timeout reason on its own is enough.)
    void sendMail({
      to: env.PASSWORD_RESET_NOTIFY_EMAIL as string,
      subject: `${env.APP_NAME}: password reset requested by ${user.fullName}`,
      text: [
        `A password reset was requested for a ${env.APP_NAME} account.`,
        '',
        `  Name:      ${user.fullName}`,
        `  Account:   ${user.email}`,
        `  Role:      ${user.role}`,
        `  Requested: ${when} (${env.REPORT_TIMEZONE})`,
        `  From IP:   ${req.ip ?? 'unknown'}`,
        '',
        `One-time code: ${code}`,
        '',
        `This code expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes and can be used once.`,
        'Give it only to this person, and only once you are satisfied they are who they say.',
        '',
        'If you were not expecting this request, do nothing — the code is useless',
        'on its own and will expire by itself.',
      ].join('\n'),
    })
      .then((result) => {
        // The only place a delivery failure is visible. Without this line the
        // administrator simply never gets a mail and nobody finds out why.
        if (!result.sent) console.error('[mail] reset code not delivered:', result.error);
      })
      // sendMail already swallows its own failures; this is here so a future
      // change to it can never take the process down with an unhandled
      // rejection on a path nothing is awaiting.
      .catch((err: unknown) => console.error('[mail] sender threw:', err));

    res.json({
      detail:
        'Your administrator has been sent a one-time code. Ask them for it, then enter it here.',
    });
  })
);

const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(1),
  new_password: z.string().min(8, 'Password must be at least 8 characters.'),
});

authRouter.post(
  '/reset-password',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const body = resetSchema.parse(req.body);
    const invalid = badRequest('That code is not valid or has expired. Ask for a new one.');

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user?.isActive) throw invalid;

    const request = await prisma.passwordResetRequest.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!request) throw invalid;

    // Normalised the same way it is shown: staff type it back in lower case, and
    // O/0 confusion is why those characters are not in the alphabet.
    const supplied = body.code.trim().toUpperCase().replace(/\s+/g, '');

    if (!(await bcrypt.compare(supplied, request.codeHash))) {
      const attempts = request.attempts + 1;
      await prisma.passwordResetRequest.update({
        where: { id: request.id },
        data: {
          attempts,
          // Burn it rather than let it be ground down one guess at a time.
          consumedAt: attempts >= MAX_RESET_ATTEMPTS ? new Date() : null,
        },
      });
      throw invalid;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(body.new_password, 10),
          // Signs out every device still holding a token from before the reset —
          // including whoever may have prompted the reset in the first place.
          passwordChangedAt: new Date(),
        },
      }),
      prisma.passwordResetRequest.update({
        where: { id: request.id },
        data: { consumedAt: new Date() },
      }),
      // Releases the device that was holding the account. This is the escape
      // hatch from the one-device rule: an administrator whose only phone was
      // lost has nobody above them to press "remove", so proving control of the
      // reset code has to be enough to free it.
      prisma.deviceSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'Password reset' },
      }),
    ]);

    res.json({
      detail: 'Password updated. Any device signed in with the old password has been released.',
    });
  })
);
