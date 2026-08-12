# Stock bulk upload

Two shapes of spreadsheet are accepted, and the importer works out which one it
has been given from the header row. Send either a `.xlsx` straight from Excel or
the same sheet saved as **CSV UTF-8** — there is no longer a save-as step to
forget.

Both templates are served by the API, so the app can offer them as a download
without anyone having to find this folder:

    GET /api/inventory/bulk-upload/template                     -> the price master
    GET /api/inventory/bulk-upload/template?format=sku          -> the SKU sheet
    GET /api/inventory/bulk-upload/columns                      -> both, as JSON

## 1. The price master

`price-master-sample.csv` is the buyer's own sheet: the merged company / product
/ pack-size list with the landed-cost build-up and one price column per shop.
It carries **no product codes**, and does not need any.

| Column | Required | What it does |
|---|---|---|
| `COMPANY` | for new products | The supplier. Stored as the product's brand, and part of its identity. |
| `PRODUCT` | **yes** | The product name. |
| `PACKSIZE` | no | Joined onto the name (`carrots` + `100g` → `Carrots 100g`) and part of its identity. |
| `COST` | no | What we pay before transport. |
| `Transport & Others` | no | Read and ignored — it is already inside `Landing`. |
| `Landing` | no | Cost delivered. **This** becomes the product's cost price; `COST` is the fallback when it is blank. |
| `MARK UP`, `GP` | no | Read and ignored: working columns the sheet uses to reach `SP`. |
| `SP` | no | The selling price every shop uses unless its own column overrides it. |
| `QTY` | no | Stock for the shop you are importing into. See "set or add" below. |
| one column per shop | no | That shop's price. Matched on the shop's name or code — see below. |

### Identity, and why a re-upload is safe

There are no product codes in this file, so one is worked out from
`COMPANY + PRODUCT + PACKSIZE` — for example `STAR-AA6DDC5B`. It is a pure
function of those three columns, so the same row in next month's sheet produces
the same code and updates the same product rather than creating a second one.

Matching ignores case and stray spacing, so `RAINBOW ` and `RAINBOW`, and
`Repacked Urea` and `Repacked  Urea`, are one product and not two.

If the same product appears on two lines, the lines are folded together: a blank
never overwrites a value. Two lines that give the *same* field two *different*
values is a real disagreement with no safe guess, and that still rejects the
file with both line numbers.

### The shop columns

Any heading that is not one of the columns above is checked against the names
and codes of your shops. A match becomes that shop's price override — the same
thing the Shop Pricing screen writes. Anything that matches nothing is listed
back to you as ignored, so a typo in a shop name cannot pass as "no prices to
set".

Two rules worth knowing:

- A row that leaves **every** shop column blank is saying nothing about shop
  prices, and none of its existing overrides change.
- A row that prices **some** shops is taken as authoritative for all the shop
  columns in the file, so a blank cell on that row removes that shop's override
  and the product's own `SP` applies again.

You can only price shops you are assigned to. Columns for the others are
reported with the reason, never silently skipped. Send `apply_shop_prices: false`
to read the columns and set no prices at all.

## 2. The SKU sheet

`stock-bulk-upload-sample.csv` is our own template, and the better file when the
shop already has real product codes. Keep the header row, replace the rows
beneath it.

| Column | Required | Notes |
|---|---|---|
| `sku` | **yes** | The product code. This is the key: a row whose SKU already exists updates that product instead of creating a second one. |
| `name` | for new products | Ignored if blank on a product that already exists. |
| `barcode` | no | What the scanner reads. Leave blank if there is none. |
| `brand` | no | |
| `category` | no | One of the fixed heads — Animal Feed, Veterinary, Maize Seed, Equipment… |
| `unit` | no | bag, bottle, piece, litre… |
| `cost_price` | no | What you pay. Drives the profit figures. |
| `selling_price` | no | What the customer pays, before VAT if the product is VAT-rated. |
| `tax_type` | no | `exempt` (default) or `vat`. |
| `quantity` | no | See "set or add" below. Blank means "do not touch the stock level". |
| `reorder_level` | no | When stock falls to this, the product shows as Low. |

## Headings are matched loosely

Case, spaces and a trailing unit in brackets are all ignored, and common
alternatives are accepted — `qty`, `stock` and `opening_stock` all mean
`quantity`; `cost`, `buying_price` and `purchase_price` all mean `cost_price`;
`price`, `sale_price`, `retail_price` and `SP` all mean `selling_price`; `code`,
`item_code` and `product_code` all mean `sku`.

One exception, because it bites: a bracketed **currency** is not ignored.
`COST (USD)` and `COST` would otherwise fold into the same column and one would
silently overwrite the other, so `COST (USD)` is read and discarded while `COST`
is kept.

Numbers may be typed the way people type them: `1,250.00`, `1 250` and `K1250`
all read as 1250.

## Set or add

`mode` is sent with the upload, not written in the file:

- **`set`** (the default) — `quantity` is the number counted on the shelf. The
  stock level becomes that number, and the difference is recorded as a
  correction. This is what an opening stock take wants.
- **`add`** — `quantity` is a delivery to be added to what is already there,
  recorded as a purchase.

## Nothing is applied until it all reads

The importer validates the whole file first. One unreadable line rejects the
upload and reports the line number — nothing is written. A partly-applied import
is worse than none, because nobody can tell which half landed and re-running it
would double the rows that did.

Send `validate_only: true` to get that report without importing: it lists what
each row would do, what the stock level would go from and to, which shop columns
were recognised, and which columns were ignored.

Maximum 1000 rows per upload. Split a bigger catalogue.
