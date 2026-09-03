# NG POS Mobile

Native Android app replicating the NG POS web system (multi-store POS + inventory
for Mama Maxx Agrovet, Zambia). Phone and tablet.

- **Stack:** Expo SDK 57, React Native 0.86, TypeScript, expo-router
- **Backend:** the existing production API — no server changes required
- **Feature/API spec:** [SPEC.md](./SPEC.md)

## Running in development

```bash
npm install
npx expo start
```

Scan the QR with Expo Go on Android. Camera scanning, SQLite and SecureStore all
work in Expo Go. **Bluetooth printing does not** — it is a custom native module
and needs the built app (below).

## Building the APK

Requires JDK 17+ and the Android SDK (`ANDROID_HOME` set).

```bash
npx expo prebuild --platform android --clean   # generates ./android
cd android
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Install on a device with `adb install -r <path>`, or copy the APK across and open
it (allow "install from unknown sources").

> The release build is signed with the auto-generated debug keystore, which is
> fine for testing but **must be replaced with a real upload key before any Play
> Store release**.

## Architecture

```
app/                    expo-router routes (file = screen)
  (tabs)/               Sell · Stock · Reports · More
  cart, scan, printer, store-picker, login
  sales, transaction/[id], refund, day-report, reminder
src/
  api/                  axios client, endpoints, types mirroring the server
  db/                   SQLite cache + offline sale queue + sync engine
  store/                zustand: auth, store selection, cart
  printing/             ESC/POS builder, receipt + Z-report layout, print helpers
  notifications/        closing-time reminder scheduling
  hooks/                catalogue loading, checkout
  ui/                   design system, shared components, responsive layout
modules/bt-printer/     custom native module (Kotlin) — Bluetooth Classic SPP
```

### Selling: locked prices and discounts

The selling price at the till is **locked**. A cashier or shop login sees the
price but cannot change it — if a customer needs a lower price they apply a
**discount** on the cart line (tap "+ Add discount"). The server caps a
cashier's discount at `MAX_CASHIER_DISCOUNT_PERCENT` (default 10%; set to 0 to
require a manager for every discount) and rejects anything larger with
`DISCOUNT_LIMIT`. A discount prints on the receipt and never changes the stored
price.

Only an **administrator** (and warehouse staff — the `costs.view` set) can tap a
line's price to change it, and a changed figure is applied only after a prompt:

- **This sale only** — the new price is used on this receipt; the catalogue is
  untouched.
- **Update <shop>'s price** — the new price is also written as that store's
  standing price (its `StorePrice` row). The org-wide base price is never
  touched here, and no other shop's price changes.

Either way the server floors the price at the product's cost price
(`PRICE_BELOW_COST`). A non-admin whose request carries a price different from
the standing one is refused with `PRICE_LOCKED`; a price equal to the standing
one is ignored, so an older build that echoes `unit_price` on every line keeps
working. The wire fields are `unit_price` and `persist_price` on each sale item.

To change a price permanently without making a sale, use **Products → edit** (or
**Store Pricing** for one shop) — that is the sanctioned path and is itself
gated by `pricing.write`.

### Closing the day

**More → Day Report** is the Z-report: net takings, the split by payment method,
gross-versus-refunds, VAT and the day's top items, printable on the same thermal
printer as a receipt with lines to write the counted cash and a signature.
**End Session** prints it and signs out, warning first if offline sales are still
queued — they are not in the figures until they sync.

Figures come from `GET /transactions/reports/daily`, which serves the sealed
snapshot the server's nightly job wrote. If that endpoint can't be reached the
screen totals the day's transactions on the device instead, using arithmetic kept
deliberately identical to the server's, and says so on screen.

**More → Closing Reminder** schedules a daily local notification at closing time;
tapping it opens the Day Report. Local rather than push on purpose — it has to
fire on a till with no signal, which is when the day is most likely to go
unclosed.

### Refunds

A sale's receipt (**More → Sales History → tap**) offers a refund to managers and
admins. Units are chosen per product, and only product IDs and quantities are
sent — `POST /transactions/:id/refund` reprices from the original, so a stale or
tampered client cannot inflate a refund. The original sale is never edited; the
reversal is a separate linked transaction and prints as a credit note.

### Offline behaviour

The catalogue for the selected store is cached in SQLite. Sales made without a
connection are queued locally and replayed automatically when connectivity
returns (a NetInfo listener drives this; `More → Sync Now` forces it).

Queued sales carry **no receipt number** — the server assigns it at sync time.
This is deliberate: receipt numbers are sequential per store per day, so letting
devices generate them would collide.

### Bluetooth printing

`modules/bt-printer` is a first-party Expo module (Kotlin) that talks Bluetooth
Classic RFCOMM/SPP — the protocol 58mm and 80mm thermal printers actually use.
It replaces the web app's dependency on the third-party RawBT app.

- Pair the printer once in Android Bluetooth settings
- Select it in the app: **More → Receipt Printer**
- Set paper width (58mm / 80mm) and optional cash-drawer kick
- Receipts are composed as ESC/POS bytes in TypeScript (`src/printing/`) and
  sent base64-encoded so control codes survive the JS bridge

Falls back to the hidden `createRfcommSocket` channel-1 constructor when a
printer's SDP record is missing — a common quirk in low-cost hardware.

## Known gaps

- **VAT inclusivity is unverified.** Every transaction in the live system is
  tax-exempt, so there was no worked example showing whether `selling_price`
  already includes 16% VAT. Controlled by `PRICES_INCLUDE_VAT` in
  `src/store/cart.ts` — confirm before selling VAT-rated stock.
- Not yet built: product CRUD, warehouses, transfers, store pricing, user
  management.
- **Sales history, refunds, the Day Report and the closing reminder have never
  run on a device.** They typecheck and bundle; nothing more. The refund and
  day-report endpoints they call exist only on `../ng-pos-backend`, which has
  itself never served a request — against the original Railway API they will 404.
- The refund total shown before confirming is estimated from the original lines
  in proportion to the units returned. The server recomputes from
  `quantity × unit_price`, so the two differ on a line that carried a discount.
- Excel import/export is intentionally left to the web app.
