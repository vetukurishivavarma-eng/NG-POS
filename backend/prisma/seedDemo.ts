import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seeds a generic, brand-free demo organisation for the trial/demo app build.
 * Shares the database with everything else but is fully isolated by organizationId.
 * Safe to re-run: everything is upserted on a natural key.
 *
 * Run against the shared DB with:  DATABASE_URL=... npx tsx prisma/seedDemo.ts
 */
async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'demo' },
    create: { name: 'Demo Store', slug: 'demo', currencySymbol: '$', vatRate: new Prisma.Decimal(0) },
    update: {},
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@demo.local' },
    create: {
      organizationId: org.id,
      email: 'admin@demo.local',
      passwordHash: await bcrypt.hash('Demo123!', 10),
      fullName: 'Demo Owner',
      role: 'ORG_ADMIN',
    },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'cashier@demo.local' },
    create: {
      organizationId: org.id,
      email: 'cashier@demo.local',
      passwordHash: await bcrypt.hash('Demo123!', 10),
      fullName: 'Demo Cashier',
      role: 'CASHIER',
    },
    update: {},
  });

  const storeSeeds = [
    { name: 'Main Store', code: 'MAIN', city: '' },
    { name: 'Second Branch', code: 'BRANCH2', city: '' },
    { name: 'Warehouse', code: 'WAREHOUSE', city: '' },
  ];

  const stores = [];
  for (const s of storeSeeds) {
    stores.push(
      await prisma.store.upsert({
        where: { organizationId_code: { organizationId: org.id, code: s.code } },
        create: { organizationId: org.id, name: s.name, code: s.code, city: s.city, country: '' },
        update: {},
      })
    );
  }

  const productSeeds = [
    { name: 'Bottled Water 500ml', sku: 'DEMO-WATER-500ML', brand: 'Generic', category: 'Beverages', cost: 0.3, price: 0.6, unit: 'piece' },
    { name: 'Cola 500ml', sku: 'DEMO-COLA-500ML', brand: 'Generic', category: 'Beverages', cost: 0.5, price: 1.0, unit: 'piece' },
    { name: 'White Bread', sku: 'DEMO-BREAD', brand: 'Generic', category: 'Bakery', cost: 0.8, price: 1.4, unit: 'piece' },
    { name: 'Milk 1L', sku: 'DEMO-MILK-1L', brand: 'Generic', category: 'Dairy', cost: 0.9, price: 1.5, unit: 'l' },
    { name: 'Rice 5kg', sku: 'DEMO-RICE-5KG', brand: 'Generic', category: 'Groceries', cost: 4.5, price: 6.5, unit: 'kg' },
    { name: 'Cooking Oil 2L', sku: 'DEMO-OIL-2L', brand: 'Generic', category: 'Groceries', cost: 3.2, price: 4.8, unit: 'l' },
    { name: 'Sugar 1kg', sku: 'DEMO-SUGAR-1KG', brand: 'Generic', category: 'Groceries', cost: 0.9, price: 1.4, unit: 'kg' },
    { name: 'Soap Bar', sku: 'DEMO-SOAP', brand: 'Generic', category: 'Household', cost: 0.4, price: 0.8, unit: 'piece' },
    { name: 'AA Batteries 4pk', sku: 'DEMO-BATT-AA4', brand: 'Generic', category: 'Household', cost: 1.5, price: 2.9, unit: 'piece' },
    { name: 'Instant Noodles', sku: 'DEMO-NOODLES', brand: 'Generic', category: 'Groceries', cost: 0.25, price: 0.5, unit: 'piece' },
  ];

  for (const p of productSeeds) {
    const product = await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: org.id, sku: p.sku } },
      create: {
        organizationId: org.id,
        name: p.name,
        sku: p.sku,
        brand: p.brand,
        category: p.category,
        costPrice: new Prisma.Decimal(p.cost),
        sellingPrice: new Prisma.Decimal(p.price),
        unit: p.unit,
        taxType: 'exempt',
      },
      update: {},
    });

    // Opening stock in the first two stores; Warehouse left empty so the
    // out-of-stock and transfer paths have something to show.
    for (const store of stores.slice(0, 2)) {
      await prisma.inventory.upsert({
        where: { storeId_productId: { storeId: store.id, productId: product.id } },
        create: {
          storeId: store.id,
          productId: product.id,
          quantity: new Prisma.Decimal(50),
          reorderLevel: new Prisma.Decimal(10),
        },
        update: {},
      });
    }
  }

  console.log('Demo seed complete.');
  console.log(`  Organisation : ${org.name} (slug: ${org.slug})`);
  console.log(`  Admin login  : ${admin.email} / Demo123!`);
  console.log(`  Cashier login: cashier@demo.local / Demo123!`);
  console.log(`  Stores       : ${stores.map((s) => s.code).join(', ')}`);
  console.log(`  Products     : ${productSeeds.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
