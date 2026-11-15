/** Hrefs for the two product drill-downs, so every "by product" list opens the same screens. */
export interface ProductScope {
  product_id?: string | null;
  name: string;
  store_id?: string | null;
  period?: string;
  from?: string;
  to?: string;
}

function qs(s: ProductScope, withName = true): string {
  const p = new URLSearchParams();
  if (s.product_id) p.set('product_id', s.product_id);
  else if (withName) p.set('name', s.name);
  if (withName) p.set('title', s.name);
  if (s.store_id) p.set('store_id', s.store_id);
  if (s.period) p.set('period', s.period);
  if (s.from && s.to) {
    p.set('from', s.from);
    p.set('to', s.to);
  }
  return p.toString();
}

/** Per shop: units, average price and every price it sold at. */
export const productDetailHref = (s: ProductScope) => `/product-detail?${qs(s)}`;
/** The individual sales below cost: receipt, shop, login, device. */
export const belowCostHref = (s: Partial<ProductScope>) => `/below-cost?${qs({ name: '', ...s }, Boolean(s.name))}`;
