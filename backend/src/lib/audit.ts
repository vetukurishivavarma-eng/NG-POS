import { Prisma } from '@prisma/client';

import { basePrisma } from '../prismaBase.js';
import {
  auditContext,
  flushAuditContext,
  newAuditContext,
  takeAuditAction,
  type AuditEntryDraft,
} from './auditContext.js';
import { badRequest } from './errors.js';

/**
 * The history of everything, written by the data layer.
 *
 * The rule the shop asked for is "nothing disappears, and every change is
 * recorded". That is not a promise a set of endpoints can make: it holds only
 * for as long as every author of every future route remembers to log what they
 * did, and the first one who forgets leaves a hole nobody notices until the
 * week somebody needs it.
 *
 * So it is enforced one level down. This is a Prisma client extension: it sees
 * every create, update and delete that reaches the database, from any route,
 * any script, any job — including ones written after this file. It reads the
 * row before the change, compares it with the row after, and hands the
 * difference to the request's audit context (`auditContext.ts`) to be written
 * when the response succeeds.
 *
 * Two jobs, not one:
 *
 *  1. **Record.** Everything in `AUDITED` below leaves an entry.
 *  2. **Refuse.** Everything in `NEVER_DELETE` cannot be deleted at all. Money
 *     that was taken over a counter is not an editing mistake, and a record of
 *     it is not the application's to remove — a sale that should not stand is
 *     voided or refunded, both of which leave the original where it is.
 */

/* --------------------------------------------------------------- the rules */

interface AuditModel {
  /** How the entry names this kind of record. Snake case, singular. */
  entity: string;
  /** What to call one row of it in a list. */
  label: (row: Record<string, unknown>) => string;
  /** Which store the change belongs to, where that is meaningful. */
  storeId?: (row: Record<string, unknown>) => string | null;
  /** Never written to the log, in either snapshot. */
  redact?: string[];
  /** Recorded as a size rather than a value — base64 images, mostly. */
  bulky?: string[];
  /** Changes to these are noise: a timestamp the ORM maintains by itself. */
  ignore?: string[];
  /** Loaded with the row so a deleted record can still be read in full. */
  include?: Record<string, boolean>;
  /**
   * True for records whose story is already told by another entry. The
   * inventory level behind a stock movement is the same fact twice, and a sale
   * of five lines would otherwise push the day's real events off the screen.
   * Still recorded — just not in the default view.
   */
  minor?: boolean;
}

const AUDITED: Record<string, AuditModel> = {
  Organization: {
    entity: 'organization',
    label: (r) => String(r.name ?? ''),
    bulky: ['logoBase64', 'invoiceLogoBase64'],
  },
  User: {
    entity: 'user',
    label: (r) => String(r.fullName || r.email || ''),
    redact: ['passwordHash'],
  },
  Store: { entity: 'store', label: (r) => String(r.name ?? '') },
  Product: {
    entity: 'product',
    label: (r) => String(r.name ?? ''),
    bulky: ['imageBase64'],
  },
  Inventory: {
    entity: 'inventory',
    label: (r) => `Stock level`,
    storeId: (r) => (r.storeId as string) ?? null,
    minor: true,
  },
  StorePrice: {
    entity: 'store_price',
    label: () => 'Store price',
    storeId: (r) => (r.storeId as string) ?? null,
  },
  Transaction: {
    entity: 'transaction',
    label: (r) => String(r.receiptNumber ?? ''),
    storeId: (r) => (r.storeId as string) ?? null,
    include: { items: true, payments: true },
  },
  StockMovement: {
    entity: 'stock_movement',
    label: (r) => String(r.reference ?? r.type ?? 'Stock movement'),
    storeId: (r) => (r.storeId as string) ?? null,
  },
  DailyReport: {
    entity: 'daily_report',
    label: (r) => String(r.date ?? ''),
    storeId: (r) => (r.storeId as string) ?? null,
  },
  Transfer: {
    entity: 'transfer',
    label: (r) => String(r.reference ?? ''),
    storeId: (r) => (r.fromStoreId as string) ?? null,
    include: { items: true },
  },
  Supplier: { entity: 'supplier', label: (r) => String(r.name ?? '') },
  SupplierInvoice: {
    entity: 'supplier_invoice',
    label: (r) => String(r.invoiceNumber ?? ''),
    storeId: (r) => (r.storeId as string) ?? null,
    include: { items: true },
  },
  SupplierPayment: { entity: 'supplier_payment', label: (r) => String(r.reference || 'Payment') },
  AppRelease: { entity: 'app_release', label: (r) => `v${r.version} (${r.buildNumber})` },
};

/**
 * Rows the application may not delete, whatever it thinks it is doing.
 *
 * Not a policy in a route — routes get rewritten. A sale, its lines, its
 * tenders, the stock movements they caused and the sealed day they were counted
 * into are the record of money changing hands. Nothing above this layer has a
 * good reason to remove one, and the one bad reason is exactly what this is
 * here to stop.
 *
 * `AuditLog` is on the list for the obvious reason.
 */
const NEVER_DELETE: Record<string, string> = {
  Transaction: 'A sale cannot be deleted. Void or refund it instead — both keep the original.',
  TransactionItem: 'A sale line cannot be deleted. Refund the sale instead.',
  Payment: 'A payment against a sale cannot be deleted. Refund the sale instead.',
  StockMovement: 'Stock history cannot be deleted. Post a correcting adjustment instead.',
  DailyReport: 'A day report cannot be deleted. Rebuild it instead.',
  AuditLog: 'History cannot be deleted.',
};

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * How many rows a single `updateMany`/`deleteMany` will be unpacked into.
 *
 * Bulk statements are rare here and small — deactivating one organisation's
 * device sessions, clearing a handful of prices. Past this the entry records
 * the statement and the count rather than the rows, because a log that copies a
 * whole table into itself protects nobody.
 */
const BULK_CAP = 50;

/* ------------------------------------------------------------ value shaping */

const REDACTED = '••••••••';

function plain(value: unknown, field: string, model: AuditModel): unknown {
  if (value === null || value === undefined) return null;
  if (model.redact?.includes(field)) return REDACTED;
  if (model.bulky?.includes(field)) {
    return typeof value === 'string' ? `<${value.length} characters>` : '<data>';
  }
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => plain(v, field, model));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = plain(v, k, model);
    }
    return out;
  }
  return value;
}

function snapshot(row: unknown, model: AuditModel): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = plain(v, k, model);
  }
  return out;
}

/**
 * `sellingPrice` reads as "Selling price" without a table of every field.
 *
 * Sentence case, not title case: the label sits inside a sentence — "Selling
 * price 150 → 190" — and "Selling Price" in the middle of one reads as a
 * spreadsheet heading that wandered in. The few fields whose plain split is
 * awkward are named outright.
 */
const FIELD_LABELS: Record<string, string> = {
  isActive: 'Active',
  sku: 'SKU',
  vatRate: 'VAT rate',
  taxType: 'Tax type',
  staffFullAccess: 'Warehouse access',
};

function fieldLabel(field: string): string {
  const named = FIELD_LABELS[field];
  if (named) return named;

  const spaced = field
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length ? `${value.length} item(s)` : 'none';
  if (typeof value === 'object') return '…';
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** Changes the ORM makes on its own; recording them says nothing. */
const ALWAYS_IGNORED = new Set(['updatedAt', 'createdAt', 'lastSeenAt', 'lastSyncAt']);

function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  model: AuditModel
): { fields: string[]; summary: string } {
  if (!before || !after) return { fields: [], summary: '' };

  const fields: string[] = [];
  const parts: string[] = [];

  for (const key of Object.keys(after)) {
    if (ALWAYS_IGNORED.has(key) || model.ignore?.includes(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    fields.push(key);
    if (parts.length < 6) parts.push(`${fieldLabel(key)} ${display(a)} → ${display(b)}`);
  }

  let summary = parts.join('; ');
  if (fields.length > parts.length) summary += ` and ${fields.length - parts.length} more`;
  return { fields, summary };
}

/* ------------------------------------------------------------- the recorder */

function push(entry: AuditEntryDraft): void {
  const context = auditContext();
  if (context) {
    context.entries.push(entry);
    return;
  }

  // Outside a request — a seed script, the nightly report job. There is no
  // response to wait for, so write it now, on its own and unawaited: a
  // background job must not fail because its bookkeeping did.
  const fallback = newAuditContext({ route: 'job' });
  fallback.entries.push(entry);
  void flushAuditContext(fallback, true);
}

function record(
  model: AuditModel,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): void {
  const row = after ?? before;
  if (!row) return;

  const context = auditContext();
  const changes = action === 'update' ? diff(before, after, model) : { fields: [], summary: '' };

  push({
    organizationId: (row.organizationId as string) ?? context?.organizationId ?? null,
    storeId: model.storeId?.(row) ?? null,
    entity: model.entity,
    entityId: String(row.id ?? ''),
    action: takeAuditAction() ?? action,
    entityLabel: model.label(row),
    summary:
      changes.summary ||
      (action === 'create' ? 'Created' : action === 'delete' ? 'Deleted' : 'Changed'),
    changedFields: changes.fields,
    before,
    after,
    minor: model.minor ?? false,
  });
}

/**
 * Records something that never touches a row of its own — a sign-in, a refused
 * password, a device released. The extension cannot see these: nothing was
 * written, and that is precisely what is worth knowing.
 */
export function recordAudit(entry: {
  entity: string;
  entityId: string;
  action: string;
  label?: string;
  summary: string;
  organizationId?: string | null;
  storeId?: string | null;
  details?: Record<string, unknown>;
  minor?: boolean;
  /** Keep this entry even if the request is about to answer 4xx — see below. */
  force?: boolean;
}): void {
  push({
    organizationId: entry.organizationId ?? null,
    storeId: entry.storeId ?? null,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    entityLabel: entry.label ?? '',
    summary: entry.summary,
    changedFields: [],
    before: null,
    after: entry.details ?? null,
    minor: entry.minor ?? false,
    force: entry.force,
  });
}

/* ----------------------------------------------------------- the extension */

interface AuditDelegate {
  findUnique: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<unknown[]>;
}

/**
 * The model's own read methods, reached by name.
 *
 * The extension is generic over every model, so the delegate can only be looked
 * up dynamically — Prisma's generated types have no way to express "whichever
 * model this call was for". Only `findUnique` and `findMany` are ever called,
 * and only with a `where` the caller already handed to Prisma.
 */
function delegate(model: string): AuditDelegate {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (basePrisma as unknown as Record<string, AuditDelegate>)[key] as AuditDelegate;
}

/**
 * Reads the row a write is about to change.
 *
 * Deliberately through `basePrisma`, and therefore outside any transaction the
 * caller has open: what it returns is the last committed state, which is the
 * right "before" for a log. It also means this read cannot see a change made
 * earlier in the same transaction — two updates to one row inside one
 * transaction are recorded against the state at its start. Worth knowing, and
 * not worth the deadlock risk of doing it any other way.
 */
async function readBefore(model: string, config: AuditModel, where: unknown) {
  try {
    return (await delegate(model).findUnique({
      where,
      ...(config.include ? { include: config.include } : {}),
    })) as Record<string, unknown> | null;
  } catch {
    // An extended-unique `where` the audit read cannot reproduce. The change
    // still happens; it is recorded without its previous state.
    return null;
  }
}

export const auditExtension = Prisma.defineExtension({
  name: 'audit',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const refusal = NEVER_DELETE[model];
        if (refusal && (operation === 'delete' || operation === 'deleteMany')) {
          throw badRequest(refusal);
        }

        const config = AUDITED[model];
        if (!config || !WRITE_OPS.has(operation)) return query(args);

        const input = args as Record<string, unknown>;

        switch (operation) {
          case 'create':
          case 'createManyAndReturn': {
            const result = await query(args);
            for (const row of Array.isArray(result) ? result : [result]) {
              record(config, 'create', null, snapshot(row, config));
            }
            return result;
          }

          case 'update':
          case 'upsert': {
            const before = await readBefore(model, config, input.where);
            const result = await query(args);
            record(
              config,
              before ? 'update' : 'create',
              snapshot(before, config),
              snapshot(result, config)
            );
            return result;
          }

          case 'delete': {
            const before = await readBefore(model, config, input.where);
            const result = await query(args);
            record(config, 'delete', snapshot(before ?? result, config), null);
            return result;
          }

          case 'updateMany':
          case 'updateManyAndReturn':
          case 'deleteMany': {
            const removing = operation === 'deleteMany';
            const before = (await delegate(model).findMany({
              where: input.where,
              take: BULK_CAP + 1,
              ...(config.include ? { include: config.include } : {}),
            })) as Record<string, unknown>[];

            const result = await query(args);

            if (before.length > BULK_CAP) {
              // Too many to itemise: record the statement itself.
              push({
                organizationId: auditContext()?.organizationId ?? null,
                storeId: null,
                entity: config.entity,
                entityId: 'bulk',
                action: removing ? 'delete_many' : 'update_many',
                entityLabel: `${before.length}+ records`,
                summary: `${removing ? 'Deleted' : 'Changed'} more than ${BULK_CAP} ${config.entity} records at once`,
                changedFields: [],
                before: { where: input.where ?? null },
                after: null,
                minor: config.minor ?? false,
              });
              return result;
            }

            if (removing) {
              for (const row of before) record(config, 'delete', snapshot(row, config), null);
              return result;
            }

            const ids = before.map((row) => row.id).filter(Boolean);
            const after = ids.length
              ? ((await delegate(model).findMany({
                  where: { id: { in: ids } },
                  ...(config.include ? { include: config.include } : {}),
                })) as Record<string, unknown>[])
              : [];
            const byId = new Map(after.map((row) => [row.id, row]));
            for (const row of before) {
              record(config, 'update', snapshot(row, config), snapshot(byId.get(row.id), config));
            }
            return result;
          }

          default:
            // `createMany` returns a count and no rows, so there is nothing to
            // snapshot. Every place that uses it here writes children of a
            // record that is itself audited (a sale's lines, an invoice's).
            return query(args);
        }
      },
    },
  },
});
