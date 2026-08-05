import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

export const PASSWORD = 'TestPassw0rd!';

export function api(): Express {
  return createApp();
}

export interface World {
  organizationId: string;
  storeId: string;
  storeCode: string;
  products: { id: string; name: string; price: number; taxType: 'exempt' | 'vat' }[];
  tokens: { admin: string; manager: string; cashier: string };
  /**
   * Addresses are unique per world because the login limiter keys on them and
   * its map lives for the life of the process — which is right in production
   * and would otherwise leak one test's lockout into the next.
   */
  emails: { admin: string; manager: string; cashier: string };
}

/**
 * One organisation, one store, three products, one user per role. Deliberately
 * small — a test that needs more should say so itself.
 */
export async function seedWorld(app: Express): Promise<World> {
  const org = await prisma.organization.create({
    data: { name: 'Test Agrovet', slug: `test-${Date.now().toString(36)}` },
  });

  const store = await prisma.store.create({
    data: { organizationId: org.id, name: 'Test Store', code: 'TESTSTORE', city: 'Lusaka' },
  });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const emails = {
    admin: `admin-${unique}@test.local`,
    manager: `manager-${unique}@test.local`,
    cashier: `cashier-${unique}@test.local`,
  };

  const roles = [
    { key: 'admin', email: emails.admin, role: 'ORG_ADMIN' as const },
    { key: 'manager', email: emails.manager, role: 'STORE_MANAGER' as const },
    { key: 'cashier', email: emails.cashier, role: 'CASHIER' as const },
  ];

  for (const r of roles) {
    await prisma.user.create({
      data: {
        organizationId: org.id,
        email: r.email,
        passwordHash,
        fullName: r.key,
        role: r.role,
      },
    });
  }

  const specs = [
    { name: 'Actellic Gold Dust', sku: 'A-1', price: 85, taxType: 'exempt' as const },
    { name: 'Bio Sulpha', sku: 'B-1', price: 175, taxType: 'exempt' as const },
    { name: 'ETG Urea', sku: 'C-1', price: 950, taxType: 'vat' as const },
  ];

  const products = [];
  for (const s of specs) {
    const product = await prisma.product.create({
      data: {
        organizationId: org.id,
        name: s.name,
        sku: s.sku,
        sellingPrice: s.price,
        costPrice: s.price / 2,
        taxType: s.taxType,
      },
    });
    await prisma.inventory.create({
      data: { storeId: store.id, productId: product.id, quantity: 100, reorderLevel: 10 },
    });
    products.push({ id: product.id, name: s.name, price: s.price, taxType: s.taxType });
  }

  const tokens = {
    admin: await login(app, emails.admin),
    manager: await login(app, emails.manager),
    cashier: await login(app, emails.cashier),
  };

  return {
    organizationId: org.id,
    storeId: store.id,
    storeCode: store.code,
    products,
    tokens,
    emails,
  };
}

export async function login(app: Express, email: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.access_token as string;
}

/** Unique per call — the column is a global unique index. */
export function clientRef(tag = 'test'): string {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function stockOf(storeId: string, productId: string): Promise<number> {
  const row = await prisma.inventory.findUnique({
    where: { storeId_productId: { storeId, productId } },
  });
  return row ? row.quantity.toNumber() : 0;
}
