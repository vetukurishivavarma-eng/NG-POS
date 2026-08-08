# NG POS — Backend

API for the NG POS multi-store point-of-sale and inventory system. Serves the
React Native app in `../ng-pos-mobile`.

**Node + TypeScript + Express + Prisma + PostgreSQL.**

> **Status: running.** As of 2026-08-04 this compiles, migrates, seeds and
> serves. Verified against Postgres: login, sale with a claimed receipt number,
> idempotent replay of the same `client_reference`, stock decrement, partial and
> full refund, role gate on refunds, day report, snapshot seal + read-through,
> and list filters. No automated tests yet — those checks were run by hand.

## Why PostgreSQL

- **Exact money.** `NUMERIC(12,2)` throughout. Float money eventually produces a
  receipt that doesn't add up.
- **Atomic sales.** Claiming a receipt number, writing the sale and decrementing
  stock happen in one transaction. This is the system's hardest correctness
  requirement.
- **Idempotency via unique index.** Offline sales replay; `client_reference` is
  `UNIQUE`, so a duplicate is rejected by the database rather than by hopeful
  application logic.
- **Analytics are SQL.** Sales/profit per product and per branch, and daily
  trends, are `GROUP BY` + `date_trunc` + `generate_series`.

## First run

```bash
npm install
cp .env.example .env          # then set JWT_SECRET
npm run db:up                 # local Postgres in Docker
npx prisma migrate dev --name init
npm run seed
npm run dev                   # http://localhost:4000
```

Seed logins (change immediately): `admin@ngpos.local` / `ChangeMe123!`,
`cashier@ngpos.local` / `ChangeMe123!`

## Pointing the app at it

In `../ng-pos-mobile/src/api/client.ts`, set `API_BASE_URL` to
`http://<your-lan-ip>:4000/api`. `localhost` will not work from a physical
device — it resolves to the phone itself.

## API

All routes are under `/api` and require `Authorization: Bearer <token>` except
`/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`,
`/api/auth/reset-password` and `/health`.

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/login`, `/auth/register`, `GET /auth/me`, `POST /auth/change-password`, `POST /auth/forgot-password`, `POST /auth/reset-password` |
| Organisation | `GET|PUT /organizations/current`, `GET /settings` |
| Stores | `GET|POST /stores`, `GET|PUT|DELETE /stores/:id` |
| Products | `GET|POST /products`, `GET|PUT|DELETE /products/:id`, `GET /products/brands`, `GET /products/with-stock/:storeId`, `POST /products/import` |
| Inventory | `GET /inventory`, `POST /inventory/movements`, `GET /inventory/movements` |
| Sales | `GET|POST /transactions`, `GET /transactions/:id`, `POST /transactions/:id/refund`, `POST /transactions/:id/void` |
| Day reports | `GET /transactions/reports/daily?store_id&date`, `GET /transactions/reports/daily/history?store_id&limit`, `POST /transactions/reports/daily/rebuild` (admin) |
| Pricing | `GET|POST /store-pricing`, `DELETE /store-pricing/:id` |
| Warehouses | `GET|POST /warehouses`, `GET /warehouses/:id/stock` |
| Transfers | `GET|POST /transfers` |
| Users | `GET|POST /users`, `PUT|DELETE /users/:id` |
| Analytics | `/analytics/dashboard`, `/sales-trend`, `/top-products`, `/sales-per-product`, `/profit-per-product`, `/sales-per-branch`, `/profit-per-branch`, `/sales-summary`, `/stores-map` |
| Sync | `GET /sync/pull?store_id&last_sync` |

Errors return `{ "detail": "..." }`, which is what the mobile client reads.

## Design decisions worth knowing

**Forgotten passwords go through a human, not a mailbox.** Staff accounts use
internal addresses (`cashier@ngpos.local`) that no mail server answers, so there
is nowhere to send a reset link — and mailing a reset to an address an attacker
controls is the hole that flow usually opens. `POST /auth/forgot-password`
instead mails a one-time code to the single address in
`PASSWORD_RESET_NOTIFY_EMAIL`; the administrator hands it to the person standing
in front of them, which is a check no emailed link can make. The code is 8
characters from an alphabet with no `O`/`0`/`I`/`1` (it gets read aloud), stored
only as a bcrypt hash, valid once, expiring after
`PASSWORD_RESET_TTL_MINUTES`, and burned after five wrong guesses. Requesting a
new code invalidates the previous one. The endpoint answers identically for
known, unknown and deactivated addresses, so it cannot enumerate staff.

Leave `PASSWORD_RESET_NOTIFY_EMAIL` unset and the feature is off — the endpoint
says so rather than accepting requests nobody will read. With SMTP unset in
development the mail is printed to the console so the flow stays testable; that
printing is disabled under `NODE_ENV=production`.

**A password change ends every other session.** `users.password_changed_at` is
compared against each token's `iat`, so changing a password, an admin resetting
one from `PUT /users/:id`, and a code reset all sign out the devices holding
older tokens. Without it, an account recovered *because* it was compromised
stays compromised for the 30 days the stolen token still has to run. The device
that made the change gets a fresh token in the response.

**Store access is checked against the tenant first.** `assertStoreAccess` looks
the store up inside the caller's organisation before its role checks, and
answers 404 — not 403 — for a store belonging to someone else, so the two cases
are indistinguishable. It is async for that reason; every call site must
`await` it.

**Prices are recalculated server-side.** The client sends product IDs and
quantities; the server prices the sale. A device offline for a week would
otherwise sell at stale prices, and a tampered client could sell at any price.
`POST /transactions` accepts no `unit_price` at all — the service takes one so a
refund can be priced at what the customer originally paid, but that is reachable
only through the refund route, never from a till. Extra fields the app sends
(`product_name`, `line_total`, `tax_amount`…) are ignored rather than trusted.

**Discounts are capped by role.** A cashier may take at most
`MAX_CASHIER_DISCOUNT_PERCENT` (default 10%) off a line; managers and admins are
unlimited, which is what a manager override is for. The cap is measured against
the whole line rather than the unit price, so a large basket cannot smuggle a
large discount through. Uncapped, this was the price-override hole in another
form — the discount could equal the line total and the goods left for nothing.

**Reversals only come from the refund route.** `POST /transactions` accepts
`transaction_type: "sale"` and nothing else, and will not take a `reverses_id`.
Otherwise the manager approval on `POST /:id/refund` is decoration — anyone able
to sell could post a refund directly and mint negative money and free stock.

**A refund can never exceed what is left on the sale.** Quantities are checked
against the original lines *minus* every earlier reversal of that same sale, so
partial refunds can be taken one unit at a time until the sale is exhausted and
not one unit further. The sale is only marked `refunded` when nothing remains on
it — flagging it on the first partial refund made the rest unreturnable.

**Tender is reconciled against that price, not believed.** Because the server
reprices, a client's payment figure can already be stale when it lands. A single
tender is therefore *set* to the sale total; a split tender must add up to it or
the sale is rejected. Without this a cash sale posted with `amount: 0` left the
day's takings right and its cash column at zero — and reconciling the drawer is
the only job the Z-report has.

**Receipt numbers are claimed, not generated.** `STORECODE-YYYYMMDD-NNNNNN`
comes from a `receipt_counters` row locked per store per day. Offline sales
therefore cannot carry a number until they sync — which is exactly why the app
queues them without one.

**Refunds create a linked reversal**, never edit the original. Stock returns and
the audit trail stays intact. The reversal records a negative payment on the
tender the sale came in on, so the day's payment split shows the drawer being
paid out of rather than merely a smaller total. A sale split across tenders is
refunded to whichever came first.

**Day reports are snapshotted, not just computed.** A nightly job writes each
store's Z-report into `daily_reports` and seals it after midnight. The figures
could always be recomputed, but a sealed row is what still matches the cash that
was counted that night — it cannot drift when an old sale is voided later, and
it survives the transaction table being archived. `GET /reports/daily` serves the
sealed row when there is one and live figures otherwise, so the endpoint's shape
never changes.

**The reporting day is the shop's day, not the server's.** Railway containers run
UTC while the shops are UTC+2, which would push every evening sale onto the next
day's report. `REPORT_TIMEZONE` (default `Africa/Lusaka`) defines the boundary,
and receipt numbers are claimed against the same day so the numbers on a report
actually carry that date.

## Scheduled jobs

`node-cron`, started from `src/index.ts` and stopped on shutdown:

| Cron | Default | What it does |
| --- | --- | --- |
| `DAILY_REPORT_CRON` | `5 21 * * *` | Snapshots the closing day, unsealed |
| `DAILY_REPORT_SEAL_CRON` | `20 0 * * *` | Re-runs yesterday (catching late offline syncs) and seals it |

Both run in `REPORT_TIMEZONE`. On boot the process also seals yesterday if the
job never got to it, so a restart at the wrong moment cannot cost a day. Set
`CRON_ENABLED=false` on every instance but one if you scale past a single
container — otherwise two of them race on the same rows.

`POST /transactions/reports/daily/rebuild` re-runs one store-day by hand; it
leaves sealed rows alone unless `force: true` is passed, so it cannot quietly
rewrite a report that has been signed off.

**Cost price is captured on the line at time of sale**, so a later supplier price
change does not rewrite last month's margins.

**Soft deletes** for stores, products and users — historical receipts reference
them.

**Roles:** `ORG_ADMIN` (everything), `STORE_MANAGER` (stock, pricing, refunds),
`CASHIER` (sell only). A user with no `assigned_stores` may use every store in
the organisation.

## Known gaps

- Test coverage is regressions only. Every bug in the table below has a test;
  the ordinary paths around them mostly do not.
- The cron has only fired via the boot catch-up, which is the same code path as
  the scheduled run but not the schedule itself. Neither cron *expression* has
  been observed firing at its time.
- **Stock is allowed to go negative.** This is deliberate — a queued offline sale
  must still record goods that physically left the shop, even if the catalogue
  now says zero — but nothing flags it, so a mis-keyed quantity looks the same as
  a legitimate oversell. Worth a report before going live.
- The discount cap is enforced server-side only. The app's cart will happily
  build a basket the server then rejects — the cashier sees the reason, which
  names the limit, but not until checkout. Surfacing the cap to the client
  (via `/organizations/current`) would move that to the point of entry.
- Rate limiting is in-memory, so it is per-container. Fine for one instance;
  move the map to Redis if this is ever scaled out.
- A refund of a split-tender sale goes back entirely on the first tender. Fine
  for cash-heavy retail; revisit if card refunds must go back to the card.
- `POST /:id/void` marks a transaction voided but does not return its stock.

## Tests

```bash
npm test          # vitest run
npm run test:watch
```

They run against a real Postgres — `<your database>_test`, dropped and recreated
on each run, on the same compose container. Mocking Prisma was rejected on
purpose: every bug these tests exist for was in how the database was actually
queried or constrained, so a fake would have gone green throughout.

Each test truncates and seeds its own world (one org, one store, three products,
one user per role). Logins use per-world addresses because the rate limiter's map
lives for the life of the process — correct in production, and otherwise one
test's lockout leaks into the next.

## Fixed 2026-08-04

Found by probing the running server; all six had passed a typecheck happily.

| Was | Now |
| --- | --- |
| A cashier could set `unit_price` — a K85 item sold for K0.01 | `unit_price` is not in the sale schema |
| A cashier could post `transaction_type: "refund"`, skipping manager approval and minting stock | Sale endpoint accepts `"sale"` only |
| A refund of 999 units against a 1-unit sale succeeded: −K84,915 and +999 stock | Capped at what remains on the sale |
| The same product on two lines was refunded twice over | Quantities aggregated per product |
| One partial refund marked the whole sale `refunded`, stranding the rest | Marked only when nothing remains |
| Unlimited password guessing on `/auth/login` | 8 per 5 min per IP+address |
| Tender was believed over the server's own price, so cash sales could post at 0 | Single tender set to the total; split must add up |
| Idempotency lookup was global, so a key collision could return another tenant's receipt | Scoped to the organisation |
| Any cashier could discount a line to zero — the price override wearing a hat | Capped at `MAX_CASHIER_DISCOUNT_PERCENT`; managers unlimited |
- Warehouse stock exists in the schema but has no receive/issue endpoints yet.
