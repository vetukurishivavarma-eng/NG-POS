/**
 * The shop's product categories.
 *
 * This is a fixed list, not free text, because the point of the feature is that
 * every product ends up under one of these heads — a `category` column anyone
 * can type into drifts into "Fertilizer", "Fertilizers" and "fertiliser" within
 * a week, and then no filter or report can be trusted.
 *
 * Keep in step with `mobile/src/api/categories.ts`, which holds the same list
 * for the picker. The two codebases share no types; `test/mobile-contract.test.ts`
 * is what notices when they disagree.
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

/**
 * What people actually type, mapped to the head it belongs under.
 *
 * The existing catalogue is the reason this exists: it already carries
 * `Fertilizers`, `Tools` and `Seeds`, and a spreadsheet coming from the shop
 * will carry British spellings and singulars too. Matching is done on a
 * flattened, de-pluralised key, so only genuinely different words need a line
 * here.
 */
const SYNONYMS: Record<string, ProductCategory> = {
  'weed killer': 'Herbicides',
  weedicide: 'Herbicides',
  pest: 'Pesticides',
  'pest control': 'Pesticides',
  fungicide: 'Fungicides',
  insecticide: 'Insecticides',
  fertiliser: 'Fertilizer', // British spelling — the common one locally.
  fert: 'Fertilizer',
  manure: 'Fertilizer',
  maize: 'Maize Seed',
  'corn seed': 'Maize Seed',
  'hybrid maize': 'Maize Seed',
  vegetable: 'Veg Seed',
  'vegetable seed': 'Veg Seed',
  veg: 'Veg Seed',
  seed: 'Other Seed',
  'general seed': 'Other Seed',
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
  sundries: 'Other',
  general: 'Other',
  misc: 'Other',
  miscellaneous: 'Other',
  others: 'Other',
};

/** Lowercase, drop punctuation, collapse whitespace. */
function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `fertilizers` → `fertilizer`, `maize seeds` → `maize seed`. */
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
 * Resolves anything a human or a spreadsheet might write to one of the heads.
 *
 * Returns `null` for blank input (a product is allowed to be uncategorised)
 * and `undefined` when the value means nothing here — the caller turns that
 * into an error rather than guessing, because silently filing an unknown
 * category under "Other" is how a mis-typed column becomes invisible.
 */
export function normaliseCategory(value: string | null | undefined): ProductCategory | null | undefined {
  if (value === null || value === undefined) return null;
  const key = flatten(value);
  if (!key) return null;
  return LOOKUP.get(key) ?? LOOKUP.get(singular(key));
}

export const CATEGORY_LIST_HINT = `Use one of: ${PRODUCT_CATEGORIES.join(', ')}.`;
