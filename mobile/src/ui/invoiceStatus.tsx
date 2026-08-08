import React from 'react';

import { Badge } from './components';
import type { SupplierInvoiceStatus } from '../api/types';

/**
 * How much of a supplier invoice is still owed, at a glance.
 *
 * Its own module rather than a helper inside a screen: expo-router treats files
 * under `app/` as routes and only expects a default export from them, so shared
 * fragments live out here.
 */
export function InvoiceStatusBadge({ status }: { status: SupplierInvoiceStatus }) {
  if (status === 'paid') return <Badge label="PAID" tone="success" />;
  if (status === 'partial') return <Badge label="PART PAID" tone="warning" dot />;
  return <Badge label="UNPAID" tone="danger" dot />;
}
