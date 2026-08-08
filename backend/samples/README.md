# Stock bulk upload

`stock-bulk-upload-sample.csv` is the file the importer expects. Keep the header
row exactly as it is, replace the rows beneath it, and save as **CSV UTF-8**
from Excel or Google Sheets.

The same file is served by the API, so the app can offer it as a download
without anyone having to find this folder:

    GET /api/inventory/bulk-upload/template   -> the CSV, as a file
    GET /api/inventory/bulk-upload/columns    -> the same thing as JSON

## The columns

| Column | Required | Notes |
|---|---|---|
| `sku` | **yes** | The product code. This is the key: a row whose SKU already exists updates that product instead of creating a second one. |
| `name` | for new products | Ignored if blank on a product that already exists. |
| `barcode` | no | What the scanner reads. Leave blank if there is none. |
| `brand` | no | |
| `category` | no | Free text — Feed, Veterinary, Seed, Equipment… |
| `unit` | no | bag, bottle, piece, litre… |
| `cost_price` | no | What you pay. Drives the profit figures. |
| `selling_price` | no | What the customer pays, before VAT if the product is VAT-rated. |
| `tax_type` | no | `exempt` (default) or `vat`. |
| `quantity` | no | See "set or add" below. Blank means "do not touch the stock level". |
| `reorder_level` | no | When stock falls to this, the product shows as Low. |

Headings are matched loosely: case, spaces, and a trailing unit in brackets are
all ignored, and common alternatives are accepted — `qty`, `stock` and
`opening_stock` all mean `quantity`; `cost`, `buying_price` and `purchase_price`
all mean `cost_price`; `price`, `sale_price` and `retail_price` all mean
`selling_price`; `code`, `item_code` and `product_code` all mean `sku`.

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
each row would do, and what the stock level would go from and to.

Maximum 1000 rows per upload. Split a bigger catalogue.
