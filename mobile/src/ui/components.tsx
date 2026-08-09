import React from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { bevel, colors, font, motion, radius, shadow, spacing } from '../theme';

export type IconName = React.ComponentProps<typeof Feather>['name'];

export function Icon({
  name,
  size = 20,
  color = colors.text,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return <Feather name={name} size={size} color={color} style={style} />;
}

/* --------------------------------------------------------------- typography */

export function Title({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Subtitle({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.subtitle, style]}>{children}</Text>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

/* ------------------------------------------------------------------ buttons */

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  size = 'md',
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'accent' | 'secondary' | 'danger' | 'ghost';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  size?: 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}) {
  const isDisabled = disabled || loading;
  const light = variant === 'primary' || variant === 'danger' || variant === 'accent';
  const fg = light ? '#fff' : variant === 'ghost' ? colors.textMuted : colors.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        size === 'lg' && styles.btnLg,
        variant === 'primary' && styles.btnPrimary,
        variant === 'accent' && styles.btnAccent,
        variant === 'secondary' && styles.btnSecondary,
        variant === 'danger' && styles.btnDanger,
        variant === 'ghost' && styles.btnGhost,
        isDisabled && styles.btnDisabled,
        pressed && !isDisabled && styles.btnPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={18} color={fg} /> : null}
          <Text style={[styles.btnText, { color: fg }, size === 'lg' && styles.btnTextLg]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/* -------------------------------------------------------------------- cards */

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  return <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
}

export function Badge({
  label,
  tone = 'neutral',
  dot,
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
  dot?: boolean;
}) {
  const tones = {
    neutral: { bg: colors.surfaceSunken, fg: colors.textMuted },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    info: { bg: colors.infoSoft, fg: colors.info },
    accent: { bg: colors.accentSoft, fg: colors.accentDeep },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: tones.bg }]}>
      {dot ? <View style={[styles.badgeDot, { backgroundColor: tones.fg }]} /> : null}
      <Text style={[styles.badgeText, { color: tones.fg }]}>{label}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------- states */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={26} color={colors.textFaint} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.empty}>
      <ActivityIndicator size="large" color={colors.primary} />
      {label ? <Text style={styles.emptyHint}>{label}</Text> : null}
    </View>
  );
}

/* --------------------------------------------------------------------- forms */

/**
 * One labelled text input. `prefix` carries the currency symbol on money fields
 * so the value itself stays a bare number.
 */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  secureTextEntry,
  multiline,
  prefix,
  hint,
  error,
  editable = true,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  secureTextEntry?: boolean;
  multiline?: boolean;
  prefix?: string;
  hint?: string;
  error?: string | null;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View
        style={[
          styles.inputWrap,
          multiline && styles.inputWrapMultiline,
          !!error && styles.inputWrapError,
          !editable && styles.inputWrapDisabled,
        ]}
      >
        {prefix ? <Text style={styles.inputPrefix}>{prefix}</Text> : null}
        <TextInput
          style={[styles.input, multiline && styles.inputMultiline]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          secureTextEntry={secureTextEntry}
          multiline={multiline}
          editable={editable}
          autoFocus={autoFocus}
        />
      </View>
      {error ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : hint ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

/**
 * Chip selector. Horizontal-scrolling so it survives long option lists on a
 * narrow till screen rather than wrapping into a ragged block.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.sm }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

/** Labelled on/off row, for booleans that read as settings rather than fields. */
export function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1, paddingRight: spacing.md }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.borderStrong, true: colors.primaryBright }}
        thumbColor={colors.surface}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ steppers */

/**
 * One control that both adds and takes away, with the running count between the
 * two halves.
 *
 * It exists once because the alternative is three of them: the cart had this
 * shape, the sell grid had a bare `+` that could only ever go up, and stock
 * corrections made you pick a direction from a dropdown before typing a number.
 * Same gesture everywhere now.
 *
 * `max` is not decoration. On the sell screen it is the stock on hand, and it
 * is the only thing standing between a cashier and a basket holding more units
 * than the shop owns — the server will happily let stock go negative, because
 * offline replay depends on that, so nothing downstream catches it.
 */
export function QtyStepper({
  value,
  onChange,
  min = 0,
  max,
  size = 'md',
  tone = 'light',
  /** Shown in place of the number when the count is zero, e.g. "Add". */
  zeroLabel,
  disabled,
  onLimit,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'light' | 'dark';
  zeroLabel?: string;
  disabled?: boolean;
  /** Called instead of `onChange` when a press would cross `min`/`max`. */
  onLimit?: (edge: 'min' | 'max') => void;
}) {
  const dims = STEPPER_SIZES[size];
  const dark = tone === 'dark';
  const atMin = value <= min;
  const atMax = max != null && value >= max;

  // The number pops when it changes, so a tap registers even when the finger is
  // covering the digits — which on a phone it usually is.
  const pop = React.useRef(new Animated.Value(1)).current;
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(pop, { toValue: 1.22, duration: 70, useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, ...motion.spring, useNativeDriver: true }),
    ]).start();
  }, [value, pop]);

  function step(by: 1 | -1) {
    if (disabled) return;
    const next = value + by;
    if (by < 0 && atMin) return onLimit?.('min');
    if (by > 0 && atMax) return onLimit?.('max');
    onChange(Math.min(max ?? Infinity, Math.max(min, next)));
  }

  const fg = dark ? '#fff' : colors.text;
  const faded = dark ? 'rgba(255,255,255,0.35)' : colors.textFaint;

  return (
    <View
      style={[
        styles.stepper,
        { height: dims.h, borderRadius: dims.h / 2, padding: dims.pad },
        dark ? styles.stepperDark : styles.stepperLight,
        disabled && styles.stepperDisabled,
      ]}
    >
      <StepButton
        icon="minus"
        dims={dims}
        dark={dark}
        color={atMin ? faded : fg}
        disabled={disabled || atMin}
        onPress={() => step(-1)}
      />

      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Text
          style={[
            styles.stepperValue,
            { fontSize: dims.font, minWidth: dims.valueWidth, color: fg },
            value === 0 && zeroLabel ? styles.stepperZero : null,
          ]}
          numberOfLines={1}
        >
          {value === 0 && zeroLabel ? zeroLabel : formatCount(value)}
        </Text>
      </Animated.View>

      <StepButton
        icon="plus"
        dims={dims}
        dark={dark}
        color={atMax ? faded : fg}
        disabled={disabled || atMax}
        onPress={() => step(1)}
      />
    </View>
  );
}

function StepButton({
  icon,
  dims,
  dark,
  color,
  disabled,
  onPress,
}: {
  icon: IconName;
  dims: StepperDims;
  dark: boolean;
  color: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // Generous, because these are small circles pressed with a thumb across a
      // counter, often one-handed while the other hand holds the goods.
      hitSlop={10}
      style={({ pressed }) => [
        styles.stepBtn,
        { width: dims.btn, height: dims.btn, borderRadius: dims.btn / 2 },
        dark ? styles.stepBtnDark : styles.stepBtnLight,
        pressed && !disabled && styles.stepBtnPressed,
        disabled && styles.stepBtnDisabled,
      ]}
    >
      <Icon name={icon} size={dims.icon} color={color} />
    </Pressable>
  );
}

interface StepperDims {
  h: number;
  btn: number;
  pad: number;
  icon: number;
  font: number;
  valueWidth: number;
}

const STEPPER_SIZES: Record<'sm' | 'md' | 'lg', StepperDims> = {
  sm: { h: 34, btn: 28, pad: 3, icon: 14, font: 14, valueWidth: 30 },
  md: { h: 40, btn: 34, pad: 3, icon: 16, font: 16, valueWidth: 38 },
  lg: { h: 56, btn: 48, pad: 4, icon: 22, font: 24, valueWidth: 72 },
};

/** Whole numbers stay whole; fractional stock (weights) keeps up to 3 places. */
function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/* --------------------------------------------------------------------- lists */

/** Generic tappable list row: leading icon, title, subtitle, trailing slot. */
export function ListRow({
  icon,
  title,
  subtitle,
  trailing,
  onPress,
  tone = 'default',
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  tone?: 'default' | 'muted';
}) {
  const body = (
    <>
      {icon ? (
        <View style={styles.rowIcon}>
          <Icon name={icon} size={17} color={colors.primary} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text
          style={[styles.rowTitle, tone === 'muted' && { color: colors.textMuted }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? (onPress ? <Icon name="chevron-right" size={18} color={colors.textFaint} /> : null)}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;

  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** Hairline between rows inside a Card. */
export function RowDivider() {
  return <View style={styles.rowDivider} />;
}

/** A label/value pair — totals, summaries, read-only detail. */
export function StatRow({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: 'default' | 'success' | 'danger';
}) {
  const color =
    tone === 'success' ? colors.success : tone === 'danger' ? colors.danger : colors.text;
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, emphasis && styles.statValueStrong, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
  },
  // The track is recessed and the two buttons sit proud of it — the inverse of
  // the bevel used on cards, which is what makes it read as a physical rocker.
  stepperLight: {
    backgroundColor: colors.surfaceSunken,
    borderTopWidth: 1,
    borderTopColor: '#D9D2C4',
    borderBottomWidth: 1,
    borderBottomColor: '#FFFFFF',
  },
  stepperDark: {
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.18)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.14)',
  },
  stepperDisabled: { opacity: 0.45 },
  stepperValue: { fontFamily: font.bold, textAlign: 'center', letterSpacing: -0.3 },
  stepperZero: { fontFamily: font.semibold, fontSize: 12, letterSpacing: 0.2 },

  stepBtn: { alignItems: 'center', justifyContent: 'center' },
  stepBtnLight: { backgroundColor: colors.surface, ...bevel.light, ...shadow.sunken },
  stepBtnDark: { backgroundColor: 'rgba(255,255,255,0.16)', ...bevel.dark },
  stepBtnPressed: { transform: [{ scale: 0.9 }], opacity: 0.85 },
  stepBtnDisabled: { backgroundColor: 'transparent', borderWidth: 0, elevation: 0, shadowOpacity: 0 },

  title: { fontFamily: font.bold, fontSize: 26, color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  sectionLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },

  btn: {
    height: 50,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  btnLg: { height: 58, borderRadius: radius.lg },
  btnPrimary: { backgroundColor: colors.primary, ...bevel.dark, ...shadow.tile },
  btnAccent: { backgroundColor: colors.accentDeep, ...bevel.dark, ...shadow.tile },
  btnSecondary: {
    backgroundColor: colors.surface,
    borderLeftWidth: 1.5,
    borderRightWidth: 1.5,
    borderLeftColor: colors.border,
    borderRightColor: colors.border,
    ...bevel.light,
    ...shadow.card,
  },
  btnDanger: { backgroundColor: colors.danger, ...bevel.dark, ...shadow.tile },
  btnGhost: { backgroundColor: 'transparent' },
  btnDisabled: { opacity: 0.4, elevation: 0, shadowOpacity: 0 },
  // Sinks rather than just fading: with the lit top edge above, losing the
  // shadow and dropping 1px is the whole illusion of a key being pushed in.
  btnPressed: {
    transform: [{ scale: 0.985 }, { translateY: 1 }],
    ...shadow.sunken,
  },
  btnText: { fontFamily: font.semibold, fontSize: 15 },
  btnTextLg: { fontSize: 17, fontFamily: font.bold },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: colors.border,
    borderRightColor: colors.border,
    ...bevel.light,
    ...shadow.tile,
  },
  cardPadded: { padding: spacing.lg },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.2 },

  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: { fontFamily: font.semibold, fontSize: 16, color: colors.text },
  emptyHint: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 280,
  },

  field: { gap: spacing.sm },
  fieldLabel: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.textMuted,
    letterSpacing: 0.2,
  },
  fieldHint: { fontFamily: font.regular, fontSize: 12, color: colors.textFaint, lineHeight: 17 },
  fieldError: { fontFamily: font.medium, fontSize: 12, color: colors.danger, lineHeight: 17 },

  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  inputWrapMultiline: { alignItems: 'flex-start', paddingVertical: spacing.md, minHeight: 96 },
  inputWrapError: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  inputWrapDisabled: { backgroundColor: colors.surfaceSunken, opacity: 0.7 },
  inputPrefix: { fontFamily: font.semibold, fontSize: 16, color: colors.textMuted },
  input: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 16,
    color: colors.text,
    paddingVertical: spacing.md,
  },
  inputMultiline: { textAlignVertical: 'top', paddingTop: 0 },

  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: font.semibold, fontSize: 13, color: colors.textMuted },
  chipTextActive: { color: colors.onDark },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  toggleLabel: { fontFamily: font.semibold, fontSize: 15, color: colors.text },

  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  rowPressed: { opacity: 0.6 },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  rowSubtitle: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: spacing.md,
  },
  statLabel: { fontFamily: font.medium, fontSize: 14, color: colors.textMuted, flexShrink: 1 },
  statValue: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  statValueStrong: { fontFamily: font.bold, fontSize: 17 },
});
