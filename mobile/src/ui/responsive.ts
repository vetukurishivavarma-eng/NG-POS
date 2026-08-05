import { useWindowDimensions } from 'react-native';

export interface Layout {
  width: number;
  height: number;
  /** Tablet-class width: the POS can afford a docked cart panel. */
  isTablet: boolean;
  /** Enough width for a three-up product grid alongside the cart. */
  isWide: boolean;
  landscape: boolean;
  /** Columns for the product grid. Phones stay single-column (list rows). */
  productColumns: number;
  /** Width reserved for the docked cart on tablets. */
  cartPanelWidth: number;
  gutter: number;
}

const TABLET_BREAKPOINT = 720;
const WIDE_BREAKPOINT = 1024;

/**
 * Breakpoints are driven by live window width, not device type, so a split-screen
 * tablet correctly falls back to the phone layout.
 */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;
  const isWide = width >= WIDE_BREAKPOINT;

  const cartPanelWidth = isWide ? 400 : isTablet ? 330 : 0;
  const contentWidth = width - cartPanelWidth;

  let productColumns = 1;
  if (isTablet) productColumns = contentWidth >= 780 ? 3 : 2;

  return {
    width,
    height,
    isTablet,
    isWide,
    landscape: width > height,
    productColumns,
    cartPanelWidth,
    gutter: isTablet ? 16 : 12,
  };
}
