import type { NextFunction, Request, Response } from 'express';

import { flushAuditContext, newAuditContext, runWithAuditContext } from '../lib/auditContext.js';

/**
 * Opens an audit context for the request and writes it out when the response is
 * done.
 *
 * Mounted before every route, including the unauthenticated ones: a refused
 * sign-in is worth recording, and by definition there is no user on it.
 *
 * The entries are written only if the response succeeded. That is the whole
 * defence against logging a change that was rolled back — the route threw, the
 * transaction went back, the status is a 4xx or 5xx, and the buffer is dropped
 * with it.
 */
export function auditRequest(req: Request, res: Response, next: NextFunction) {
  const context = newAuditContext({ ip: req.ip ?? null });

  const finish = () => {
    // Read here rather than above: `req.route` is whatever matched, and nothing
    // has matched yet when this middleware runs. The pattern is what belongs in
    // the column — `/api/products/:id` groups, where a URL full of ids does not.
    context.route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    // `close` also fires when the client hung up mid-response. If the handler
    // had already succeeded the writes are committed, so they are still true.
    void flushAuditContext(context, res.statusCode < 400);
  };
  res.on('finish', finish);
  res.on('close', finish);

  runWithAuditContext(context, () => next());
}
