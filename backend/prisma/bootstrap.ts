import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Opens a production database: one organisation, one administrator, nothing
 * else.
 *
 * This is deliberately not `seed.ts`. The seed exists so a developer has
 * something to talk to on first run, and it carries three demo shops, eight
 * demo products and two accounts on a password that is written down in the
 * repository. None of that belongs in a database a shop is about to trade
 * from — and two of its products are filed under `Organics`, a category the
 * fixed taxonomy in `lib/categories.ts` refuses, so they would be uneditable
 * the moment anyone opened them.
 *
 * Everything past the admin account is entered through the app: shops on the
 * Shops screen, the catalogue through the CSV bulk upload, which is what that
 * feature was built for.
 *
 * Run it against the new database directly, from a machine that can reach it:
 *
 *   DATABASE_URL=<external url> DIRECT_URL=<external url> \
 *   ORG_NAME='Mama Maxx Agrovet' ADMIN_EMAIL=owner@example.com \
 *   ADMIN_NAME='Ravi K' ADMIN_PASSWORD='<a real one>' \
 *   npm run bootstrap
 *
 * Safe to re-run. An organisation or user that already exists is left exactly
 * as it is — in particular the password is never rewritten, so this cannot be
 * used to overwrite a live admin's credentials by accident.
 */

/** Reads a required setting, or explains which one is missing and stops. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. This script has no defaults on purpose — a production ` +
        `database should not inherit a password that is written down somewhere.`
    );
  }
  return value;
}

/**
 * A slug is derived rather than asked for. It is a join key, not a label, and
 * one typed by hand at 1am is the kind of thing that ends up as "Mama Maxx ".
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function main() {
  const orgName = required('ORG_NAME');
  const adminEmail = required('ADMIN_EMAIL').toLowerCase();
  const adminName = required('ADMIN_NAME');
  const adminPassword = required('ADMIN_PASSWORD');

  // The seed's password is in the repository, in the READMEs and in several
  // months of chat logs. It is the one string that must not reach production.
  if (adminPassword === 'ChangeMe123!') {
    throw new Error('ADMIN_PASSWORD is the demo password. Choose a real one.');
  }
  if (adminPassword.length < 10) {
    throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  }

  /*
   * How long shop staff may add products.
   *
   * This has to be set explicitly. `staffProductAddUntil` is nullable, and
   * `capabilities.ts` reads null as "the window was never closed" — i.e. open
   * forever. On the existing organisation a migration set a real date, so the
   * two-month grant the client agreed to is only true there. A fresh database
   * left at null would hand every shop assistant permanent product-entry
   * rights, which is the opposite of what was decided.
   *
   * PRODUCT_ENTRY_MONTHS=0 closes it immediately; the date can be moved later
   * from the database if the catalogue takes longer than expected.
   */
  const months = Number(process.env.PRODUCT_ENTRY_MONTHS ?? 2);
  if (!Number.isFinite(months) || months < 0) {
    throw new Error('PRODUCT_ENTRY_MONTHS must be a number of months, 0 or more.');
  }
  const productEntryUntil = new Date();
  productEntryUntil.setMonth(productEntryUntil.getMonth() + months);

  const slug = slugify(orgName);
  const existingOrg = await prisma.organization.findUnique({ where: { slug } });

  const org = await prisma.organization.upsert({
    where: { slug },
    create: { name: orgName, slug, staffProductAddUntil: productEntryUntil },
    update: {},
  });

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      organizationId: org.id,
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      fullName: adminName,
      role: 'ORG_ADMIN',
    },
    update: {},
  });

  // Report what actually happened rather than what was asked for. Re-running
  // this and being told "created" when nothing changed is how a stale password
  // gets believed.
  console.log(existingOrg ? `Organisation already existed: ${org.name}` : `Created organisation: ${org.name}`);
  console.log(`  slug                 ${org.slug}`);
  console.log(`  vat rate             ${org.vatRate.toString()}`);
  console.log(`  currency             ${org.currencySymbol}`);
  console.log(
    `  staff may add products until ${
      org.staffProductAddUntil?.toISOString().slice(0, 10) ?? 'no limit set'
    }`
  );
  console.log(existingAdmin ? `Admin already existed: ${admin.email}` : `Created admin: ${admin.email}`);
  if (existingAdmin) {
    console.log('  password left unchanged — this script never overwrites one.');
  }

  const [stores, products, users] = await Promise.all([
    prisma.store.count({ where: { organizationId: org.id } }),
    prisma.product.count({ where: { organizationId: org.id } }),
    prisma.user.count({ where: { organizationId: org.id } }),
  ]);
  console.log(`\nOrganisation now holds ${users} user(s), ${stores} shop(s), ${products} product(s).`);
  console.log('Next: sign in as the admin, create the shops, then load the catalogue');
  console.log('through Stock Import (CSV). Do not run `npm run seed` against this database.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
