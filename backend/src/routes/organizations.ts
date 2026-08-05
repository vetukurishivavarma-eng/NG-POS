import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { num } from '../lib/serialize.js';

export const organizationsRouter = Router();
organizationsRouter.use(authenticate);

function serialize(o: {
  id: string;
  name: string;
  slug: string;
  logoBase64: string | null;
  invoiceLogoBase64: string | null;
  vatRate: { toNumber(): number };
  currencySymbol: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    logo_base64: o.logoBase64,
    invoice_logo_base64: o.invoiceLogoBase64,
    vat_rate: num(o.vatRate as never),
    currency_symbol: o.currencySymbol,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

organizationsRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: currentUser(req).organizationId },
    });
    res.json(serialize(org));
  })
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  logo_base64: z.string().nullable().optional(),
  invoice_logo_base64: z.string().nullable().optional(),
  vat_rate: z.number().min(0).max(1).optional(),
  currency_symbol: z.string().min(1).max(4).optional(),
});

organizationsRouter.put(
  '/current',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);

    const org = await prisma.organization.update({
      where: { id: currentUser(req).organizationId },
      data: {
        name: body.name,
        slug: body.slug,
        logoBase64: body.logo_base64,
        invoiceLogoBase64: body.invoice_logo_base64,
        vatRate: body.vat_rate,
        currencySymbol: body.currency_symbol,
      },
    });

    res.json(serialize(org));
  })
);

/** Alias kept because the mobile client also reads settings from `/settings`. */
organizationsRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: currentUser(req).organizationId },
    });
    res.json(serialize(org));
  })
);
