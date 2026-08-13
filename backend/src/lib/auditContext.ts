import { AsyncLocalStorage } from 'node:async_hooks';

import { basePrisma } from '../prismaBase.js';

/**
 * Who is making the change currently in flight.
 *
 * The audit trail is written from inside the data layer, which knows exactly
 * *what* changed and nothing at all about *who* changed it — that lives on the
 * HTTP request, several call frames up. Threading an actor through every
 * service signature to get it down there would be a large change that the next
 * new route could forget to make, and a trail with holes in it is worth very
 * little.
 *
 * `AsyncLocalStorage` carries it instead: one middleware opens a store per
 * request, `authenticate` fills in the actor once the token resolves, and the
 * Prisma extension reads it wherever it happens to be running.
 */

export interface AuditActor {
  id: string;
  name: string;
  role: string;
}

export interface AuditEntryDraft {
  organizationId: string | null;
  storeId: string | null;
  entity: string;
  entityId: string;
  action: string;
  entityLabel: string;
  summary: string;
  changedFields: string[];
  before: unknown;
  after: unknown;
  minor: boolean;
  /**
   * Written even when the request failed.
   *
   * The buffer is dropped on a 4xx/5xx because a failed request usually means a
   * rolled-back change, and logging one would be a lie. A refused sign-in is
   * the opposite case: the 401 *is* the event, and it is the one entry on this
   * whole endpoint anybody will ever come looking for.
   */
  force?: boolean;
}

export interface AuditContext {
  organizationId: string | null;
  actor: AuditActor | null;
  deviceId: string | null;
  deviceName: string | null;
  ip: string | null;
  route: string;
  /**
   * Buffered rather than written as they happen.
   *
   * A write inside an interactive transaction has not been committed yet, so
   * logging it immediately would leave an entry behind for a change that was
   * rolled back a moment later — a sale the log insists happened and the books
   * have never heard of. Holding them until the response is sent, and dropping
   * them if it failed, keeps the trail to things that actually landed. It also
   * turns a five-line sale's worth of entries into one insert.
   */
  entries: AuditEntryDraft[];
  /**
   * Names the next audited write, for the handful of changes whose meaning is
   * bigger than the column that moved. `status: completed → voided` is
   * technically an update; to the shop it is a void, and the log should say so.
   * Consumed by the next entry and then cleared.
   */
  pendingAction: string | null;
  flushed: boolean;
}

const storage = new AsyncLocalStorage<AuditContext>();

export function runWithAuditContext<T>(context: AuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function auditContext(): AuditContext | undefined {
  return storage.getStore();
}

export function newAuditContext(init: Partial<AuditContext> = {}): AuditContext {
  return {
    organizationId: null,
    actor: null,
    deviceId: null,
    deviceName: null,
    ip: null,
    route: '',
    entries: [],
    pendingAction: null,
    flushed: false,
    ...init,
  };
}

/** Called by `authenticate` once the token has been resolved to a person. */
export function setAuditActor(
  actor: AuditActor,
  organizationId: string,
  device?: { id: string; name: string }
): void {
  const context = storage.getStore();
  if (!context) return;
  context.actor = actor;
  context.organizationId = organizationId;
  if (device) {
    context.deviceId = device.id;
    context.deviceName = device.name;
  }
}

/**
 * Labels the next audited write — `void`, `refund`, `deactivate` — instead of
 * letting it be recorded as a plain `update`.
 */
export function nextAuditAction(action: string): void {
  const context = storage.getStore();
  if (context) context.pendingAction = action;
}

/** Takes the label set by `nextAuditAction`, if there is one. */
export function takeAuditAction(): string | null {
  const context = storage.getStore();
  if (!context) return null;
  const action = context.pendingAction;
  context.pendingAction = null;
  return action;
}

/**
 * Writes the buffered entries.
 *
 * Called when the response is done. `ok` is false for a 4xx/5xx, which is how a
 * rolled-back transaction is recognised without the data layer knowing anything
 * about transactions: the request failed, so whatever it was in the middle of
 * doing did not happen.
 *
 * Never throws. A trail that can turn a completed sale into a 500 is worse than
 * a trail with a gap in it, so a failure here is logged to the console and the
 * request is left alone.
 */
export async function flushAuditContext(context: AuditContext, ok: boolean): Promise<void> {
  if (context.flushed) return;
  context.flushed = true;

  const buffered = context.entries;
  context.entries = [];

  // A failed request keeps only what asked to survive it — see `force`.
  const entries = ok ? buffered : buffered.filter((entry) => entry.force);
  if (entries.length === 0) return;

  try {
    await basePrisma.auditLog.createMany({
      data: entries.map((entry) => ({
        organizationId: entry.organizationId ?? context.organizationId,
        storeId: entry.storeId,
        entity: entry.entity,
        entityId: entry.entityId,
        action: entry.action,
        entityLabel: entry.entityLabel,
        summary: entry.summary,
        changedFields: entry.changedFields,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
        actorId: context.actor?.id ?? null,
        actorName: context.actor?.name ?? '',
        actorRole: context.actor?.role ?? '',
        deviceId: context.deviceId,
        deviceName: context.deviceName,
        ip: context.ip,
        route: context.route,
        minor: entry.minor,
      })),
    });
  } catch (err) {
    console.error('[audit] failed to write %d entries:', entries.length, err);
  }
}
