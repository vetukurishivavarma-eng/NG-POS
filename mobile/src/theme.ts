/**
 * Visual language for NG POS.
 *
 * The web app's stock emerald-on-cold-grey was a starting point, not a target.
 * This palette is warmer and more specific to the business: deep field green
 * against a bone-paper canvas, with harvest gold carrying emphasis. Warm
 * neutrals throughout — no blue-grey, which is what makes most dashboards read
 * as generic.
 */

export const colors = {
  // Deep field green — primary actions, active state.
  primary: '#0F5F47',
  primaryDeep: '#0A4433',
  primaryBright: '#12805E',
  primarySoft: '#E2EFE9',

  // Harvest gold — the accent. Used sparingly: totals, highlights, warnings.
  accent: '#DFA02C',
  accentDeep: '#B77F16',
  accentSoft: '#FBF0D9',

  // Warm neutrals. Bone paper, not cold grey.
  canvas: '#F6F4EF',
  surface: '#FFFFFF',
  surfaceSunken: '#EFEBE3',
  border: '#E5DFD4',
  borderStrong: '#D3CBBC',

  // Near-black with a green cast, so text sits in the same family as the brand.
  ink: '#10201A',
  text: '#16261F',
  textMuted: '#6A7A72',
  textFaint: '#9AA79F',
  onDark: '#F2F6F3',
  onDarkMuted: '#9BB0A6',

  // Terracotta rather than fire-engine red — sits with the warm neutrals.
  danger: '#C0442C',
  dangerSoft: '#FAE7E2',
  success: '#0F7A54',
  successSoft: '#DFF1E8',
  warning: '#B77F16',
  warningSoft: '#FBF0D9',
  info: '#2C5F86',
  infoSoft: '#E2EDF5',
} as const;

export const font = {
  regular: 'Jakarta_400Regular',
  medium: 'Jakarta_500Medium',
  semibold: 'Jakarta_600SemiBold',
  bold: 'Jakarta_700Bold',
  extrabold: 'Jakarta_800ExtraBold',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

/**
 * Elevation via soft, warm-tinted shadow. Android needs `elevation`; the colour
 * keeps the shadow from turning the bone canvas grey.
 */
export const shadow = {
  card: {
    shadowColor: '#3B3327',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#241F16',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  /**
   * A card that reads as a physical object rather than a rectangle.
   *
   * The depth comes from three things together, and dropping any one of them
   * flattens it: a wider, softer shadow than `card`; the `bevel` highlight
   * below drawn along the top edge; and the surface sinking on press. A bigger
   * blur radius on its own just looks blurry.
   */
  tile: {
    shadowColor: '#2C2519',
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  /** What a tile drops to while held down — travelling toward the page. */
  sunken: {
    shadowColor: '#2C2519',
    shadowOpacity: 0.05,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
} as const;

/**
 * Edge lighting.
 *
 * A lit top edge and a shaded bottom one are what separate a raised surface
 * from a flat fill — the shadow underneath only says the object floats, not
 * which way up it is. Applied as ordinary borders so there is no gradient
 * dependency and nothing to fail on Android.
 */
export const bevel = {
  /** For white/near-white surfaces on the bone canvas. */
  light: {
    borderTopColor: '#FFFFFF',
    borderTopWidth: 1,
    borderBottomColor: '#DFD8CA',
    borderBottomWidth: 1.5,
  },
  /** For the deep-green and gold fills, where white would be too loud. */
  dark: {
    borderTopColor: 'rgba(255,255,255,0.22)',
    borderTopWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.22)',
    borderBottomWidth: 1.5,
  },
} as const;

/**
 * Motion.
 *
 * Everything is short. A till is used a few hundred times a day by someone who
 * already knows what the button does, and an animation they have to wait for
 * becomes the slowest part of the sale. These durations are on the edge of
 * being felt rather than watched.
 */
export const motion = {
  /** Press feedback — must feel simultaneous with the finger. */
  instant: 90,
  /** State changes: a count ticking, a badge appearing. */
  quick: 160,
  /** The arc of an item flying to the cart. Long enough to be followed. */
  travel: 460,
  spring: { damping: 15, stiffness: 220, mass: 0.7 },
} as const;

/** Zambian Kwacha, e.g. `K1,234.00`. */
export function formatKwacha(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}K${Math.abs(n).toLocaleString('en-ZM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Splits money for display so the decimals can be de-emphasised. */
export function splitAmount(amount: number | null | undefined): {
  whole: string;
  decimals: string;
} {
  const formatted = formatKwacha(amount);
  const idx = formatted.lastIndexOf('.');
  return idx === -1
    ? { whole: formatted, decimals: '' }
    : { whole: formatted.slice(0, idx), decimals: formatted.slice(idx) };
}
