import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seeds one organisation with stores, a small agro-vet catalogue and opening
 * stock, so the mobile app has something real to talk to on first run.
 *
 * Safe to re-run: everything is upserted on a natural key.
 */
async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'mama-maxx' },
    create: { name: 'Mama Maxx Agrovet', slug: 'mama-maxx' },
    update: {},
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@ngpos.local' },
    create: {
      organizationId: org.id,
      email: 'admin@ngpos.local',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      fullName: 'Ravi K',
      role: 'ORG_ADMIN',
    },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'cashier@ngpos.local' },
    create: {
      organizationId: org.id,
      email: 'cashier@ngpos.local',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      fullName: 'Counter Staff',
      role: 'CASHIER',
    },
    update: {},
  });

  const storeSeeds = [
    { name: 'Kapilamikwa', code: 'KAPILAMIKWA', city: 'Kapilamikwa' },
    { name: 'Lusaka', code: 'LUSAKA001', city: 'Lusaka' },
    { name: 'Shop 1 Kalulushi', code: 'SHOP1KALULUS', city: 'Kalulushi' },
  ];

  const stores = [];
  for (const s of storeSeeds) {
    stores.push(
      await prisma.store.upsert({
        where: { organizationId_code: { organizationId: org.id, code: s.code } },
        create: { organizationId: org.id, name: s.name, code: s.code, city: s.city },
        update: {},
      })
    );
  }

  const productSeeds = [
    { name: 'Snow Cron 1Ltr', sku: 'SNOW-SNOWCRON-1LTR', brand: 'SNOW', category: 'Insecticides', cost: 180, price: 240, unit: 'l' },
    { name: 'Tetra Power 500ml', sku: 'EXOME-TETRAPOWER-500ML', brand: 'EXOME', category: 'Fertilizers', cost: 95, price: 140, unit: 'ml' },
    { name: 'Bio Sulpha 1Ltr', sku: 'GREENORG-BIOSULPHA-1LTR', brand: 'GREEN ORGANICS', category: 'Organics', cost: 120, price: 175, unit: 'l' },
    { name: 'Actellic Gold Dust 200g', sku: 'SYNGENTA-ACTELLICGOLD-200G', brand: 'Syngenta', category: 'Insecticides', cost: 55, price: 85, unit: 'g' },
    { name: 'Manco 250g', sku: 'ETG-MANCO-250G', brand: 'ETG', category: 'Fungicides', cost: 40, price: 65, unit: 'g' },
    { name: 'ETG Urea 50kg', sku: 'ETG-UREA-50KG', brand: 'ETG', category: 'Fertilizers', cost: 780, price: 950, unit: 'kg' },
    { name: 'Hoe', sku: 'KUSHI-HOE', brand: 'Kushi', category: 'Tools', cost: 60, price: 95, unit: 'piece' },
    { name: 'Carrots 100g', sku: 'STARKE-CARROTS-100G', brand: 'Starke Ayres', category: 'Seeds', cost: 70, price: 110, unit: 'g' },
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

    // Opening stock in the first store only, so the other two exercise the
    // out-of-stock path in the app.
    const first = stores[0];
    if (first) {
      await prisma.inventory.upsert({
        where: { storeId_productId: { storeId: first.id, productId: product.id } },
        create: {
          storeId: first.id,
          productId: product.id,
          quantity: new Prisma.Decimal(40),
          reorderLevel: new Prisma.Decimal(10),
        },
        update: {},
      });
    }
  }

  console.log('Seed complete.');
  console.log(`  Organisation : ${org.name}`);
  console.log(`  Admin login  : ${admin.email} / ChangeMe123!`);
  console.log(`  Stores       : ${stores.map((s) => s.code).join(', ')}`);
  console.log(`  Products     : ${productSeeds.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
