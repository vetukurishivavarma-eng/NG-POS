import { create } from 'zustand';
import type { PaymentMethod, ProductWithStock, TransactionItem } from '../api/types';

export const VAT_RATE = 0.16;

/**
 * UNVERIFIED: whether `selling_price` already includes VAT.
 * Every transaction in the live data is `tax_type: "exempt"`, so there was no
 * worked example to check against. Set to `true` if the shop quotes
 * VAT-inclusive shelf prices (the Zambian retail norm) — it changes only this
 * one function.
 */
const PRICES_INCLUDE_VAT = false;

export interface CartLine {
  product: ProductWithStock;
  quantity: number;
  /** Per-line discount in Kwacha, not a percentage. */
  discount: number;
  /**
   * Reprices this line at checkout. Server-floored at the product's cost
   * price for every role (see `createSale` in the backend) — once accepted,
   * it also becomes the new catalogue selling price and clears any per-shop
   * override, so the Sell screen and the product catalogue both pick it up.
   */
  priceOverride?: number;
}

interface CartState {
  lines: CartLine[];
  customerName: string;
  customerPhone: string;
  notes: string;

  add: (product: ProductWithStock, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  setDiscount: (productId: string, discount: number) => void;
  setPriceOverride: (productId: string, price: number | undefined) => void;
  remove: (productId: string) => void;
  clear: () => void;
  setCustomer: (name: string, phone?: string) => void;
  setNotes: (notes: string) => void;
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  customerName: '',
  customerPhone: '',
  notes: '',

  add: (product, quantity = 1) =>
    set((s) => {
      const existing = s.lines.find((l) => l.product.id === product.id);
      if (existing) {
        return {
          lines: s.lines.map((l) =>
            l.product.id === product.id
              ? { ...l, quantity: capToStock(l.product, l.quantity + quantity) }
              : l
          ),
        };
      }
      return {
        lines: [...s.lines, { product, quantity: capToStock(product, quantity), discount: 0 }],
      };
    }),

  setQuantity: (productId, quantity) =>
    set((s) => ({
      lines:
        quantity <= 0
          ? s.lines.filter((l) => l.product.id !== productId)
          : s.lines.map((l) =>
              l.product.id === productId ? { ...l, quantity: capToStock(l.product, quantity) } : l
            ),
    })),

  setDiscount: (productId, discount) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.product.id === productId ? { ...l, discount: Math.max(0, discount) } : l
      ),
    })),

  setPriceOverride: (productId, price) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.product.id === productId
          ? { ...l, priceOverride: price === undefined || price < 0 ? undefined : price }
          : l
      ),
    })),

  remove: (productId) => set((s) => ({ lines: s.lines.filter((l) => l.product.id !== productId) })),

  clear: () => set({ lines: [], customerName: '', customerPhone: '', notes: '' }),

  setCustomer: (customerName, customerPhone = '') => set({ customerName, customerPhone }),
  setNotes: (notes) => set({ notes }),
}));

/**
 * How far a product may be sold past what the shelf shows, once it is
 * already at or below zero. A real item can be physically in the shop while
 * the count is stale or simply wrong, so a sale must not be refused outright
 * — but an unbounded shortfall is more likely a miscount than ten more
 * customers, so it stops here rather than climbing forever.
 */
export const OVERSELL_FLOOR = -10;

/**
 * The most a line may hold.
 *
 * Nothing downstream enforces this. The server reprices from product ids and
 * then lets the level go negative on purpose, because an offline till replaying
 * yesterday's sales must not be rejected for stock it did not know about — so a
 * basket of 50 units of a 3-unit product posts cleanly and the shortfall only
 * surfaces at the next count.
 *
 * While stock is positive this is simply what's on the shelf. Once it is at
 * or below zero, selling is still allowed — the sell screen no longer refuses
 * it — but only until the count would reach `OVERSELL_FLOOR`.
 *
 * `quantity` is as of the last catalogue sync. That is the number the cashier
 * is looking at on the same screen, so capping to it can never contradict what
 * they can see.
 */
export function maxSellable(product: ProductWithStock): number {
  const available = Number(product.quantity ?? 0);
  if (!Number.isFinite(available)) return Number.POSITIVE_INFINITY;
  if (available > 0) return available;
  return Math.max(0, available - OVERSELL_FLOOR);
}

export function capToStock(product: ProductWithStock, wanted: number): number {
  return Math.max(0, Math.min(wanted, maxSellable(product)));
}

export interface CartTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  itemCount: number;
}

export function unitPriceOf(line: CartLine): number {
  return line.priceOverride ?? line.product.selling_price;
}

/**
 * True once a typed-in price is known to undercut cost. `cost_price` reads
 * as 0 for an account that cannot see costs, so this is a soft client-side
 * hint only — the server floors it authoritatively either way and returns a
 * cost-free message to such an account (see `createSale`'s `PRICE_BELOW_COST`).
 */
export function isBelowCost(line: CartLine): boolean {
  const price = line.priceOverride;
  return price !== undefined && line.product.cost_price > 0 && price < line.product.cost_price;
}

export function lineToTransactionItem(line: CartLine): TransactionItem {
  const unitPrice = unitPriceOf(line);
  const gross = unitPrice * line.quantity;
  const net = Math.max(0, gross - line.discount);

  let taxable = 0;
  let tax = 0;
  if (line.product.tax_type === 'vat') {
    if (PRICES_INCLUDE_VAT) {
      taxable = net / (1 + VAT_RATE);
      tax = net - taxable;
    } else {
      taxable = net;
      tax = net * VAT_RATE;
    }
  }

  return {
    product_id: line.product.id,
    product_name: line.product.name,
    sku: line.product.sku,
    brand: line.product.brand ?? null,
    quantity: line.quantity,
    unit_price: unitPrice,
    discount_amount: round2(line.discount),
    tax_type: line.product.tax_type,
    tax_amount: round2(tax),
    line_total: round2(PRICES_INCLUDE_VAT ? net : net + tax),
  };
}

export function computeTotals(lines: CartLine[]): CartTotals {
  const items = lines.map(lineToTransactionItem);
  const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const discount = items.reduce((sum, i) => sum + i.discount_amount, 0);
  const tax = items.reduce((sum, i) => sum + i.tax_amount, 0);
  const total = items.reduce((sum, i) => sum + i.line_total, 0);
  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    tax: round2(tax),
    total: round2(total),
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

export const PAYMENT_METHODS: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: 'cash', label: 'Cash', icon: '💵' },
  { key: 'card', label: 'Card', icon: '💳' },
  { key: 'mobile', label: 'Mobile', icon: '📱' },
];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
