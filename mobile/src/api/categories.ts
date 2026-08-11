/**
 * The shop's product categories — the picker's options and the filter chips.
 *
 * `backend/src/lib/categories.ts` is the source of truth; this is the same list
 * so the app can render a picker without a round trip, and the contract test
 * asserts the two still agree. The server normalises on write, so a product
 * saved from this app always carries one of these exact strings.
 */
export const PRODUCT_CATEGORIES = [
  'Herbicides',
  'Pesticides',
  'Fungicides',
  'Insecticides',
  'Fertilizer',
  'Maize Seed',
  'Veg Seed',
  'Other Seed',
  'Equipment',
  'Animal Feed',
  'Veterinary',
  'Other',
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Legacy spellings still sitting in the catalogue from before the list existed. */
const SYNONYMS: Record<string, ProductCategory> = {
  'weed killer': 'Herbicides',
  weedicide: 'Herbicides',
  pest: 'Pesticides',
  fungicide: 'Fungicides',
  insecticide: 'Insecticides',
  fertiliser: 'Fertilizer',
  fert: 'Fertilizer',
  manure: 'Fertilizer',
  maize: 'Maize Seed',
  'corn seed': 'Maize Seed',
  vegetable: 'Veg Seed',
  'vegetable seed': 'Veg Seed',
  veg: 'Veg Seed',
  seed: 'Other Seed',
  tool: 'Equipment',
  equipment: 'Equipment',
  implement: 'Equipment',
  feed: 'Animal Feed',
  'stock feed': 'Animal Feed',
  'poultry feed': 'Animal Feed',
  'chicken feed': 'Animal Feed',
  mash: 'Animal Feed',
  meal: 'Animal Feed',
  vet: 'Veterinary',
  'vet medicine': 'Veterinary',
  veterinary: 'Veterinary',
  'veterinary medicine': 'Veterinary',
  medicine: 'Veterinary',
  drug: 'Veterinary',
  vaccine: 'Veterinary',
  dewormer: 'Veterinary',
  general: 'Other',
  misc: 'Other',
  others: 'Other',
};

function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function singular(value: string): string {
  return value
    .split(' ')
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .join(' ');
}

const LOOKUP = new Map<string, ProductCategory>();
for (const category of PRODUCT_CATEGORIES) {
  LOOKUP.set(flatten(category), category);
  LOOKUP.set(singular(flatten(category)), category);
}
for (const [alias, category] of Object.entries(SYNONYMS)) {
  LOOKUP.set(flatten(alias), category);
  LOOKUP.set(singular(flatten(alias)), category);
}

/**
 * Which head a stored value belongs to, or `null` when it is blank or means
 * nothing here.
 *
 * The picker runs every product's saved category through this on load, so an
 * old row reading "Fertilizers" opens with **Fertilizer** already selected and
 * one reading "Organics" opens as *Not set* — waiting to be filed rather than
 * offering a choice the server would refuse to save.
 */
export function normaliseCategory(value: string | null | undefined): ProductCategory | null {
  if (!value) return null;
  const key = flatten(value);
  if (!key) return null;
  return LOOKUP.get(key) ?? LOOKUP.get(singular(key)) ?? null;
}
