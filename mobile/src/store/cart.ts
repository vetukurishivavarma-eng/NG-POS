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
}

interface CartState {
  lines: CartLine[];
  customerName: string;
  customerPhone: string;
  notes: string;

  add: (product: ProductWithStock, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  setDiscount: (productId: string, discount: number) => void;
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
            l.product.id === product.id ? { ...l, quantity: l.quantity + quantity } : l
          ),
        };
      }
      return { lines: [...s.lines, { product, quantity, discount: 0 }] };
    }),

  setQuantity: (productId, quantity) =>
    set((s) => ({
      lines:
        quantity <= 0
          ? s.lines.filter((l) => l.product.id !== productId)
          : s.lines.map((l) => (l.product.id === productId ? { ...l, quantity } : l)),
    })),

  setDiscount: (productId, discount) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.product.id === productId ? { ...l, discount: Math.max(0, discount) } : l
      ),
    })),

  remove: (productId) => set((s) => ({ lines: s.lines.filter((l) => l.product.id !== productId) })),

  clear: () => set({ lines: [], customerName: '', customerPhone: '', notes: '' }),

  setCustomer: (customerName, customerPhone = '') => set({ customerName, customerPhone }),
  setNotes: (notes) => set({ notes }),
}));

export interface CartTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  itemCount: number;
}

export function lineToTransactionItem(line: CartLine): TransactionItem {
  const gross = line.product.selling_price * line.quantity;
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
    unit_price: line.product.selling_price,
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
