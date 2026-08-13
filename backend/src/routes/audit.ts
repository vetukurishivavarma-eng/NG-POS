import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';

/**
 * Reading the history.
 *
 * Writing it is the data layer's job (`lib/audit.ts`); this is only the window
 * onto it. Two questions get asked in a shop, and there is an endpoint for each:
 * "what has been going on?" — the list — and "who touched *this*?" — the trail
 * of one record, which is what the History button on a receipt or a product
 * opens.
 */
export const auditRouter = Router();
auditRouter.use(authenticate);

const entityFilter = z
  .string()
  .regex(/^[a-z_]+(,[a-z_]+)*$/, 'entity must be a comma-separated list of names');

const listQuery = z.object({
  entity: entityFilter.optional(),
  entity_id: z.string().optional(),
  store_id: z.string().uuid().optional(),
  actor_id: z.string().uuid().optional(),
  action: z.string().optional(),
  search: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /**
   * The stock level behind a movement, and the like. Off by default — see the
   * `minor` column on the model. An enum rather than a boolean because
   * `z.coerce.boolean()` reads the string "false" as true.
   */
  include_minor: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * The stores whose history this person may read, or `null` for "all of them".
 *
 * An administrator, and anyone at the warehouse, sees the organisation. A
 * manager sees the shops they are assigned to — including the entries with no
 * store on them at all (a product renamed, a staff account changed), which are
 * organisation-level facts that affect every till they run.
 */
function storeScope(user: { role: string; assignedStores: string[] }): string[] | null {
  if (user.role === 'ORG_ADMIN') return null;
  if (user.assignedStores.length === 0) return null;
  return user.assignedStores;
}

auditRouter.get(
  '/',
  requireCapability('audit.read'),
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const user = currentUser(req);

    if (q.store_id) await assertStoreAccess(user, q.store_id);

    const scope = storeScope(user);
    const entities = q.entity?.split(',');

    // The store scope and the search are both "any of these", and putting two
    // `OR`s in one object silently drops the first — which here would widen the
    // scope past what this person may read. They go in `AND` as separate terms.
    const anyOf: Prisma.AuditLogWhereInput[] = [];
    if (q.store_id) {
      anyOf.push({ storeId: q.store_id });
    } else if (scope) {
      // Entries with no store are organisation-level and belong to everyone who
      // can read history at all: a renamed product changes every till's screen.
      anyOf.push({ OR: [{ storeId: { in: scope } }, { storeId: null }] });
    }
    if (q.search) {
      anyOf.push({
        OR: [
          { entityLabel: { contains: q.search, mode: 'insensitive' } },
          { summary: { contains: q.search, mode: 'insensitive' } },
          { actorName: { contains: q.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.AuditLogWhereInput = {
      organizationId: user.organizationId,
      ...(entities ? { entity: entities.length === 1 ? entities[0] : { in: entities } } : {}),
      ...(q.entity_id ? { entityId: q.entity_id } : {}),
      ...(q.actor_id ? { actorId: q.actor_id } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.include_minor === 'true' ? {} : { minor: false }),
      ...(anyOf.length ? { AND: anyOf } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      total,
      limit: q.limit,
      offset: q.offset,
      entries: rows.map(serializeAuditEntry),
    });
  })
);

/**
 * Everything that ever happened to one record, oldest change last.
 *
 * Not scoped by store: if you may read the history at all and you can name the
 * record, you may see its trail. The list above is the discovery surface, and
 * that is where the narrowing belongs.
 */
auditRouter.get(
  '/:entity/:id',
  requireCapability('audit.read'),
  asyncHandler(async (req, res) => {
    const params = z
      .object({ entity: z.string().regex(/^[a-z_]+$/), id: z.string().min(1) })
      .parse(req.params);
    const user = currentUser(req);

    const rows = await prisma.auditLog.findMany({
      where: {
        organizationId: user.organizationId,
        entity: params.entity,
        entityId: params.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    if (rows.length === 0) {
      // Distinguishable from an empty history only in wording, and that is the
      // useful half: a record with no entries predates the trail, and saying so
      // stops it being read as "nobody has touched this".
      throw notFound('No history for that record. It may predate the audit trail.');
    }

    res.json({
      entity: params.entity,
      entity_id: params.id,
      label: rows[0]?.entityLabel ?? '',
      entries: rows.map(serializeAuditEntry),
    });
  })
);

/** What the app receives. Snake case, like every other response here. */
function serializeAuditEntry(row: {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  entityLabel: string;
  summary: string;
  changedFields: string[];
  before: unknown;
  after: unknown;
  actorId: string | null;
  actorName: string;
  actorRole: string;
  deviceName: string | null;
  storeId: string | null;
  ip: string | null;
  route: string;
  minor: boolean;
  createdAt: Date;
}) {
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entityId,
    action: row.action,
    label: row.entityLabel,
    summary: row.summary,
    changed_fields: row.changedFields,
    before: row.before ?? null,
    after: row.after ?? null,
    actor_id: row.actorId,
    actor_name: row.actorName,
    actor_role: row.actorRole,
    device_name: row.deviceName,
    store_id: row.storeId,
    ip: row.ip,
    route: row.route,
    minor: row.minor,
    created_at: row.createdAt.toISOString(),
  };
}
