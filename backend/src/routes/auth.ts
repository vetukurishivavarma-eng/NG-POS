import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { env, passwordResetConfigured } from '../env.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, signToken } from '../middleware/auth.js';
import { serializeUser } from '../lib/serialize.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { sendMail } from '../lib/mailer.js';
import { rateLimit } from '../middleware/rateLimit.js';

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

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Same message and comparable timing whether the address is unknown or the
    // password is wrong, so the endpoint can't be used to enumerate accounts.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) throw unauthorized('Incorrect email or password.');
    if (!user.isActive) throw unauthorized('This account has been deactivated.');

    res.json({
      access_token: signToken(user.id, user.organizationId),
      token_type: 'bearer',
      user: serializeUser(user),
    });
  })
);

const registerSchema = z.object({
  organization_name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens only.'),
  full_name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
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

    res.status(201).json({
      access_token: signToken(user.id, user.organizationId),
      token_type: 'bearer',
      user: serializeUser(user),
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

    // Every other device holding a pre-change token is now signed out. Hand this
    // one a fresh token so the person who *made* the change isn't logged out by
    // their own action.
    res.json({
      detail: 'Password updated.',
      access_token: signToken(me.id, me.organizationId),
      token_type: 'bearer',
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

    // Everything below is best-effort and deliberately invisible to the caller:
    // the response is identical for a real address, an unknown one, and a
    // deactivated account, so this endpoint cannot enumerate staff.
    if (user?.isActive) {
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

      await sendMail({
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
      });
    }

    res.json({
      detail:
        'If that account exists, your administrator has been sent a one-time code. Ask them for it, then enter it here.',
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
    ]);

    res.json({ detail: 'Password updated. Sign in with your new password.' });
  })
);
