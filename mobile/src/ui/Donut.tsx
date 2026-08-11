/**
 * A donut chart drawn with nothing but Views.
 *
 * `react-native-svg` would be the obvious tool and is deliberately not used: it
 * is a native module, so adding it means nobody can look at this chart until a
 * fresh APK is built and installed. This draws with layout and transforms only,
 * so it appears the moment the JS bundle reloads.
 *
 * The technique, since it is not obvious from the code:
 *
 *   - A **clip window** covers the right half of the circle — that is exactly a
 *     180° span. Rotating that window by `start` moves the span to
 *     `[start, start + 180]`.
 *   - Inside it sits a **half-disc** that fills the window. Rotated *back* by
 *     `sweep - 180`, it occupies `[start + sweep - 180, start + sweep]`, and the
 *     window keeps only the overlap: `[start, start + sweep]`. That is the slice.
 *   - Both rotate about the circle's centre, which sits on the left edge of both
 *     boxes — hence `transformOrigin: '0% 50%'`.
 *
 * Angles run clockwise from twelve o'clock, matching how the eye reads a pie.
 * A slice can therefore never exceed 180° on its own, so wider ones are split.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing } from '../theme';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** The widest span one clip window can express. */
const MAX_SWEEP = 180;

/**
 * Neighbouring slices are grown a hair into each other so anti-aliasing cannot
 * leave a canvas-coloured hairline between them. Each slice is painted over the
 * previous one, so the overgrowth is always covered — except on the last, which
 * would otherwise paint over the first.
 */
const SEAM_OVERLAP_DEGREES = 0.6;

export function Donut({
  slices,
  size = 168,
  thickness = 30,
  holeColor = colors.surface,
  caption,
  value,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  /** Should match whatever the ring is sitting on, since it is a covering disc. */
  holeColor?: string;
  /** Small label inside the ring. */
  caption?: string;
  /** Headline figure inside the ring. */
  value?: string;
}) {
  // A negative slice has no arc to draw. Callers are expected to catch that and
  // show figures instead, but clamping here means a bad number cannot produce a
  // chart that is silently wrong.
  const parts = slices.filter((s) => s.value > 0);
  const total = parts.reduce((sum, s) => sum + s.value, 0);

  const wedges: { key: string; start: number; sweep: number; color: string }[] = [];
  let cursor = 0;

  parts.forEach((slice, index) => {
    const isLast = index === parts.length - 1;
    // The last slice takes whatever is left rather than its own rounded share,
    // so accumulated rounding cannot leave a sliver of bare ring at the end.
    const share = isLast ? 360 - cursor : (slice.value / total) * 360;
    const drawn = isLast ? share : share + SEAM_OVERLAP_DEGREES;

    let remaining = drawn;
    let angle = cursor;
    let chunk = 0;
    while (remaining > 0.0001) {
      const step = Math.min(MAX_SWEEP, remaining);
      wedges.push({ key: `${slice.key}-${chunk}`, start: angle, sweep: step, color: slice.color });
      angle += step;
      remaining -= step;
      chunk += 1;
    }

    cursor += share;
  });

  const hole = size - thickness * 2;

  return (
    <View
      style={[
        styles.ring,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          // The base coat is the first slice's colour so the seam where the last
          // slice meets the first, at twelve o'clock, has nothing to show through.
          backgroundColor: parts[0]?.color ?? colors.surfaceSunken,
        },
      ]}
    >
      {wedges.map((w) => (
        <View
          key={w.key}
          style={[
            styles.clip,
            { left: size / 2, width: size / 2, height: size, transform: [{ rotate: `${w.start}deg` }] },
          ]}
        >
          <View
            style={{
              width: size / 2,
              height: size,
              borderTopRightRadius: size / 2,
              borderBottomRightRadius: size / 2,
              backgroundColor: w.color,
              transformOrigin: '0% 50%',
              transform: [{ rotate: `${w.sweep - MAX_SWEEP}deg` }],
            }}
          />
        </View>
      ))}

      <View
        style={[
          styles.hole,
          {
            left: thickness,
            top: thickness,
            width: hole,
            height: hole,
            borderRadius: hole / 2,
            backgroundColor: holeColor,
          },
        ]}
      >
        {value ? (
          <Text style={styles.holeValue} numberOfLines={1} adjustsFontSizeToFit>
            {value}
          </Text>
        ) : null}
        {caption ? <Text style={styles.holeCaption}>{caption}</Text> : null}
      </View>
    </View>
  );
}

/**
 * The legend carries the actual money — the ring only carries the proportions,
 * and a shopkeeper checking a figure against the till needs the figure.
 */
export function DonutLegend({
  slices,
  format,
  total,
}: {
  slices: DonutSlice[];
  format: (value: number) => string;
  /** Denominator for the percentages; defaults to the sum of the slices. */
  total?: number;
}) {
  const sum = total ?? slices.reduce((acc, s) => acc + s.value, 0);

  return (
    <View style={styles.legend}>
      {slices.map((slice) => {
        const share = sum > 0 ? (slice.value / sum) * 100 : null;
        return (
          <View key={slice.key} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: slice.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {slice.label}
            </Text>
            <Text style={styles.legendShare}>{share === null ? '—' : `${share.toFixed(1)}%`}</Text>
            <Text
              style={[styles.legendValue, slice.value < 0 && { color: colors.danger }]}
              numberOfLines={1}
            >
              {format(slice.value)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { overflow: 'hidden' },
  clip: { position: 'absolute', top: 0, overflow: 'hidden', transformOrigin: '0% 50%' },
  hole: { position: 'absolute', alignItems: 'center', justifyContent: 'center', padding: spacing.sm },
  holeValue: {
    fontFamily: font.extrabold,
    fontSize: 19,
    color: colors.text,
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  holeCaption: {
    fontFamily: font.medium,
    fontSize: 10,
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 2,
    textAlign: 'center',
  },

  legend: { gap: spacing.xs, flex: 1, minWidth: 190 },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.canvas,
  },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.text },
  legendShare: { fontFamily: font.medium, fontSize: 11, color: colors.textMuted, width: 44, textAlign: 'right' },
  legendValue: { fontFamily: font.bold, fontSize: 12, color: colors.text, width: 86, textAlign: 'right' },
});
