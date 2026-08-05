import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, signToken } from '../middleware/auth.js';
import { serializeUser } from '../lib/serialize.js';
import { badRequest, unauthorized } from '../lib/errors.js';
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
      data: { passwordHash: await bcrypt.hash(body.new_password, 10) },
    });

    res.json({ detail: 'Password updated.' });
  })
);
