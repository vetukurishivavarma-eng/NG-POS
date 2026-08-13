import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { corsOrigins, env } from './env.js';
import { auditRequest } from './middleware/auditRequest.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { rateLimit } from './middleware/rateLimit.js';

import { appRouter } from './routes/app.js';
import { auditRouter } from './routes/audit.js';

import { authRouter } from './routes/auth.js';
import { organizationsRouter } from './routes/organizations.js';
import { storesRouter } from './routes/stores.js';
import { productsRouter } from './routes/products.js';
import { inventoryRouter } from './routes/inventory.js';
import { transactionsRouter } from './routes/transactions.js';
import { analyticsRouter } from './routes/analytics.js';
import { supplierInvoicesRouter, suppliersRouter } from './routes/suppliers.js';
import { devicesRouter } from './routes/devices.js';
import {
  storePricingRouter,
  syncRouter,
  transfersRouter,
  usersRouter,
  warehousesRouter,
} from './routes/misc.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: false }));
  // Base64 product images and bulk imports push past the 100kb default.
  app.use(express.json({ limit: '10mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // Above the routes and above the rate limiter, so that every change made by
  // any of them is recorded against whoever made it. Costs nothing on a read.
  app.use(auditRequest);

  /**
   * A ceiling on any one address, under which the sensitive endpoints keep their
   * own much tighter limits. Sized for a branch: several tills behind one NAT
   * address, each syncing a catalogue and posting sales, stays far beneath it —
   * a script walking the API does not.
   *
   * `clearOnSuccess` off on purpose: this caps throughput, and a limiter that
   * forgives every success can never be reached by the traffic it exists for.
   * Health checks sit above it so an uptime probe can't be locked out.
   */
  if (env.NODE_ENV !== 'test') {
    app.use(
      '/api',
      rateLimit({
        windowMs: 60_000,
        max: 600,
        clearOnSuccess: false,
        message: 'Too many requests from this connection. Slow down and try again shortly.',
      })
    );
  }

  // Unauthenticated on purpose: the app asks what the current build is before
  // anybody has signed in, because a build too old to be trusted should not get
  // as far as the login screen.
  app.use('/api/app', appRouter);

  app.use('/api/auth', authRouter);
  app.use('/api/audit-logs', auditRouter);
  // What the client calls it in conversation.
  app.use('/api/history', auditRouter);
  app.use('/api/organizations', organizationsRouter);
  app.use('/api/settings', organizationsRouter);
  app.use('/api/stores', storesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/supplier-invoices', supplierInvoicesRouter);
  // The client calls a delivery a "purchase"; the record is a supplier invoice.
  // Same router, so either name works and neither has to be the one true one.
  app.use('/api/purchases', supplierInvoicesRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/store-pricing', storePricingRouter);
  app.use('/api/warehouses', warehousesRouter);
  app.use('/api/transfers', transfersRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/sync', syncRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
