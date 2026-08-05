import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { corsOrigins, env } from './env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

import { authRouter } from './routes/auth.js';
import { organizationsRouter } from './routes/organizations.js';
import { storesRouter } from './routes/stores.js';
import { productsRouter } from './routes/products.js';
import { inventoryRouter } from './routes/inventory.js';
import { transactionsRouter } from './routes/transactions.js';
import { analyticsRouter } from './routes/analytics.js';
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

  app.use('/api/auth', authRouter);
  app.use('/api/organizations', organizationsRouter);
  app.use('/api/settings', organizationsRouter);
  app.use('/api/stores', storesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/store-pricing', storePricingRouter);
  app.use('/api/warehouses', warehousesRouter);
  app.use('/api/transfers', transfersRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/sync', syncRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
