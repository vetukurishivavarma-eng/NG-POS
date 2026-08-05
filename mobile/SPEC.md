# NG POS Mobile — Feature & API Spec

Reverse-engineered from https://disciplined-recreation-production.up.railway.app
Audited: 2026-08-03. Org: "Mama Maxx Agrovet" (agro-vet retail, Zambia).

## 1. What the system is

Multi-store POS + inventory for an agro-vet retail chain.
- 13 active stores, 2 warehouses, 435 products in the org catalog
- Currency: Zambian Kwacha (K). VAT 16%, per-product opt-in (`exempt` default)
- Frontend: React SPA (CRA), Zustand + persist, PostHog analytics
- Backend: REST at `/api`, JWT bearer token in `localStorage.pos_token`

## 2. Architecture facts that shape the mobile app

| Fact | Consequence for mobile |
|---|---|
| Auth = bearer token, not cookies | RN can call the same API directly. **No backend changes needed.** |
| `/api/sync/pull?store_id&last_sync` exists | Server already supports delta sync — reuse for offline cache |
| `pos-offline` store has `pendingTransactions[]` | Offline sale queue is an established pattern here; mirror it |
| Receipts print via **RawBT** (Android ESC/POS app) | Android-first. RawBT is invoked by intent/URL scheme |
| Every entity carries `organization_id` + `store_id` | Multi-tenant; store switcher is core navigation, not a setting |
| Products have `barcode` field (mostly null today) | Camera scanning is supported by the data model but catalog is unpopulated |

## 3. Screens in the web app (13 routes)

| Route | Purpose | Mobile priority |
|---|---|---|
| `/dashboard` | KPI tiles, sales trend, top products, low stock, per-branch/product sales & profit, recent txns | P1 |
| `/pos` | Checkout: search, brand filter, product grid, cart, 3 payment methods, Credit Note, Daily Report, End Session | **P0** |
| `/products` | Catalog CRUD, Excel import/export template | P1 |
| `/inventory` | Stock levels per store, reorder levels, stock movements, Excel upload | P1 |
| `/warehouses` | Warehouse CRUD + stock distribution | P2 |
| `/transfers` | Store-to-store stock transfers | P2 |
| `/transactions` | Sales history, credit notes, refund, print | P1 |
| `/analytics` | Cross-store reports, period filter, print | P2 |
| `/stores` | Store CRUD (name, code, address, geo, phone, email) | P2 |
| `/store-pricing` | Per-store price overrides vs default price | P2 |
| `/users` | Staff + role + assigned stores | P2 |
| `/settings` | Org name, slug, logos (system + invoice) | P3 |
| `/admin` | Not explored (superuser) | P3 |

## 4. API surface

Base: `/api` — `Authorization: Bearer <token>`

**Auth** `POST /auth/login`, `POST /auth/register`
**Org** `GET /organizations/current`, `GET|PUT /organizations/{id}`
**Stores** `GET|POST /stores`, `GET|PUT|DELETE /stores/{id}`
**Products** `GET|POST /products`, `GET|PUT|DELETE /products/{id}`, `GET /products/brands`,
`GET /products/with-stock/{store_id}`, `POST /products/import`, `GET /products/template`
**Inventory** `GET /inventory`, stock movements
**Warehouses** `GET|POST /warehouses`, `/warehouses/{id}`, `/warehouse-transfers`
**Transfers** `GET|POST /transfers`, `/transfers/{id}`
**Transactions** `GET|POST /transactions`, `/transactions/{id}` (sale, refund, credit note)
**Store pricing** `/store-pricing`
**Users** `GET|POST /users`, `/users/{id}`
**Analytics** `/analytics/dashboard`, `/sales-trend?days=`, `/top-products?limit=`,
`/sales-per-product`, `/profit-per-product`, `/sales-per-branch`, `/profit-per-branch`,
`/sales-summary`, `/stores-map` — all take `store_id` and/or `period=daily|weekly|monthly`
**Sync** `GET /sync/pull?store_id&last_sync=<iso>`
**Settings** `/settings`, **Reports** `/report`

## 5. Data models (verified from live responses)

```jsonc
// Product
{ id, organization_id, name, description, sku, barcode, brand, category,
  cost_price, selling_price, tax_type: "exempt"|"vat", unit, variants[],
  is_active, image_base64, created_at, updated_at }

// Store
{ id, organization_id, name, code,
  address: { street, city, province, postal_code, country },
  location: { latitude, longitude }, phone, email, is_active, last_sync_at }

// Transaction
{ id, organization_id, store_id, receipt_number: "STORECODE-YYYYMMDD-NNNNNN",
  transaction_type: "sale"|"refund"|"credit_note", status: "completed"|"refunded"|"voided",
  items: [{ product_id, product_name, sku, brand, quantity, unit_price,
            discount_amount, tax_type, tax_amount, line_total }],
  subtotal, discount_amount, tax_amount, total,
  payments: [{ method: "cash"|"card"|"mobile", amount, reference }],
  cashier_id, cashier_name, customer_name, customer_phone, notes, void_* }

// Inventory row
{ product_id, store_id, quantity, reorder_level, value, status }
```

Receipt numbering is server-side and sequential per store per day — offline sales
must NOT invent receipt numbers; queue and let the server assign on sync.

## 6. Roles

`Organization Admin` (seen) — all stores, all modules. Others implied by
`users.assigned_stores` and role-filtered sidebar: likely Store Manager / Cashier.
Needs confirmation from the /users "Add User" role dropdown.

## 7. Mobile app plan (React Native + Expo)

### Navigation
Bottom tabs, role-filtered:
- **Sell** (POS) · **Stock** (inventory + products) · **Reports** (dashboard+analytics) · **More**
- Store switcher in the header — persistent, drives every query
- Stacked screens for detail/CRUD; modals for cart payment, product edit

### What changes vs web
- Product list → **large touch tiles + sticky search + camera barcode scan**
- Cart → bottom sheet, swipe-to-remove, big Pay button
- Tables (transactions, inventory, pricing) → cards, not scrollable tables
- Excel import/export → **dropped on mobile** (desktop-only workflow)
- Settings/logo upload → dropped or read-only
- Add: pull-to-refresh, offline banner, haptics on scan/add-to-cart

### Offline strategy
- SQLite (expo-sqlite) cache of products + inventory for the selected store
- Hydrate via `/sync/pull`, store `last_sync`
- Sales made offline → queue in SQLite → replay on reconnect → server assigns receipt #
- Conflict rule: stock is authoritative server-side; flag oversell on sync

### Receipt printing
Match the web app: hand off to **RawBT** via its Android intent/URL scheme.
Android only; iOS would need a different path (share sheet PDF, or Bluetooth SDK
in a dev build). Requires an Expo **dev build**, not Expo Go.

## 8. Open questions

1. Roles/permission matrix beyond Org Admin
2. Whether iOS is in scope (printing story differs materially)
3. Credit Note / End Session / Daily Report semantics — never opened in the web
   app, so we defined our own on `../ng-pos-backend` rather than guessing at
   theirs. **These are additions, not observed behaviour, and the original
   Railway API will 404 on them:**
   - `GET /transactions/reports/daily?store_id&date` — Z-report figures
   - `GET /transactions/reports/daily/history?store_id&limit`
   - `POST /transactions/reports/daily/rebuild` (admin)
   - `POST /transactions/:id/refund` — `{ reason?, items?[{product_id,quantity}],
     client_reference? }`; omit `items` for a full refund
   - `GET /transactions` also accepts `type`, `status`, `from`, `to`

   End Session is treated as: print the Z-report, then sign out. If the web app
   turns out to mean something else (a cash-count reconciliation record, say),
   this is the assumption to revisit.
4. Whether API allows CORS/native origin (native has no CORS, so likely fine)
