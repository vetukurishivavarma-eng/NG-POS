import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '../theme';

/** Plain-JS pickers (no native module): a calendar popup and a searchable multi-select dropdown. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const key = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function Field({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} numberOfLines={1}>
        {value} ▾
      </Text>
    </Pressable>
  );
}

/** A date field that opens a month calendar. `value` is YYYY-MM-DD. */
export function DateField({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date();
  const [year, setYear] = useState(start.getFullYear());
  const [month, setMonth] = useState(start.getMonth());

  const cells = useMemo(() => {
    const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Monday first
    const days = new Date(year, month + 1, 0).getDate();
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)] as (number | null)[];
  }, [year, month]);

  const step = (by: number) => {
    const d = new Date(year, month + by, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  return (
    <>
      <Field label={label} value={value} onPress={() => setOpen(true)} />
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.monthRow}>
              <Pressable onPress={() => step(-1)} hitSlop={12}>
                <Text style={styles.arrow}>‹</Text>
              </Pressable>
              <Text style={styles.month}>
                {MONTHS[month]} {year}
              </Text>
              <Pressable onPress={() => step(1)} hitSlop={12}>
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            </View>
            <View style={styles.grid}>
              {DAYS.map((d) => (
                <Text key={d} style={[styles.cell, styles.dow]}>
                  {d}
                </Text>
              ))}
              {cells.map((d, i) => {
                const k = d ? key(year, month, d) : '';
                const blocked = !!d && !!max && k > max;
                return d ? (
                  <Pressable
                    key={i}
                    disabled={blocked}
                    onPress={() => {
                      onChange(k);
                      setOpen(false);
                    }}
                    style={[styles.cell, k === value && styles.cellOn]}
                  >
                    <Text style={[styles.cellText, k === value && styles.cellOnText, blocked && { opacity: 0.3 }]}>{d}</Text>
                  </Pressable>
                ) : (
                  <View key={i} style={styles.cell} />
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** A dropdown that opens a searchable list with tick boxes. Empty selection = everything. */
export function MultiSelectField({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  const summary =
    selected.size === 0 ? allLabel : selected.size === 1 ? [...selected][0]! : `${selected.size} selected`;

  const toggle = (o: string) => {
    const n = new Set(selected);
    if (!n.delete(o)) n.add(o);
    onChange(n);
  };

  return (
    <>
      <Field label={label} value={summary} onPress={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.full}>
          <View style={styles.listHead}>
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search products"
              placeholderTextColor={colors.textMuted}
              style={styles.search}
              autoFocus
            />
            <Pressable onPress={() => setOpen(false)} hitSlop={10}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => onChange(new Set())} style={styles.row}>
            <Text style={[styles.rowText, selected.size === 0 && styles.rowOn]}>
              {selected.size === 0 ? '☑' : '☐'} {allLabel}
            </Text>
          </Pressable>
          <FlatList
            data={shown}
            keyExtractor={(o) => o}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable onPress={() => toggle(item)} style={styles.row}>
                <Text style={[styles.rowText, selected.has(item) && styles.rowOn]}>
                  {selected.has(item) ? '☑' : '☐'} {item}
                </Text>
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#fff',
  },
  fieldLabel: { fontSize: 11, color: colors.textMuted },
  fieldValue: { fontSize: 15, color: colors.text, marginTop: 2 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: spacing.lg },
  sheet: { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  month: { fontSize: 16, fontWeight: '700', color: colors.text },
  arrow: { fontSize: 28, color: colors.primary, paddingHorizontal: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  dow: { color: colors.textMuted, fontSize: 12, textAlign: 'center', aspectRatio: undefined, paddingVertical: 4 },
  cellText: { color: colors.text, fontSize: 14 },
  cellOn: { backgroundColor: colors.primary },
  cellOnText: { color: '#fff' },
  full: { flex: 1, backgroundColor: colors.canvas },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  search: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    color: colors.text,
    backgroundColor: '#fff',
  },
  done: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  row: { paddingHorizontal: spacing.lg, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowText: { fontSize: 15, color: colors.text },
  rowOn: { color: colors.primary, fontWeight: '700' },
});
