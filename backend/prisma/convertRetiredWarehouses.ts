/**
 * One-off: promote anything left in the retired `warehouses_retired` /
 * `warehouse_stock_retired` tables into a real Store (flagged as the warehouse)
 * plus its inventory, so it shows up in transfers and on the till.
 *
 * Safe to run more than once — it skips a warehouse that already has a matching
 * store, and a stock row that already has matching inventory. It never deletes
 * the retired tables; drop them by hand once you're happy.
 *
 *   DATABASE_URL=<external> DIRECT_URL=<external> CONFIRM_DATABASE=ngpos \
 *     npx tsx prisma/convertRetiredWarehouses.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface RetiredWarehouse {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  is_active: boolean;
  created_at: Date;
}

interface RetiredStock {
  warehouse_id: string;
  product_id: string;
  quantity: string;
}

async function main() {
  if (process.env.CONFIRM_DATABASE !== 'ngpos') {
    throw new Error('Refusing to run without CONFIRM_DATABASE=ngpos');
  }

  const warehouses = await prisma.$queryRawUnsafe<RetiredWarehouse[]>(
    'SELECT id, organization_id, name, code, is_active, created_at FROM warehouses_retired'
  );
  console.log(`Found ${warehouses.length} retired warehouse row(s).`);

  for (const w of warehouses) {
    const existing = await prisma.store.findUnique({ where: { id: w.id } });
    if (existing) {
      console.log(`  ${w.name}: a store with this id already exists — skipped.`);
      continue;
    }

    const codeClash = await prisma.store.findFirst({
      where: { organizationId: w.organization_id, code: w.code },
      select: { id: true },
    });
    const code = codeClash ? `${w.code}-WH` : w.code;

    await prisma.store.create({
      data: {
        id: w.id,
        organizationId: w.organization_id,
        name: w.name,
        code,
        isActive: w.is_active,
        staffFullAccess: true,
        createdAt: w.created_at,
      },
    });
    console.log(`  ${w.name}: created as a warehouse store (code ${code}).`);
  }

  const stock = await prisma.$queryRawUnsafe<RetiredStock[]>(
    'SELECT warehouse_id, product_id, quantity FROM warehouse_stock_retired'
  );
  let moved = 0;
  for (const row of stock) {
    const store = await prisma.store.findUnique({ where: { id: row.warehouse_id }, select: { id: true } });
    const product = await prisma.product.findUnique({ where: { id: row.product_id }, select: { id: true } });
    if (!store || !product) continue;

    await prisma.inventory.upsert({
      where: { storeId_productId: { storeId: row.warehouse_id, productId: row.product_id } },
      create: { storeId: row.warehouse_id, productId: row.product_id, quantity: row.quantity },
      update: {},
    });
    moved += 1;
  }
  console.log(`Moved ${moved} stock row(s) into inventory.`);
  console.log('Done. Drop warehouses_retired / warehouse_stock_retired by hand when ready.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
