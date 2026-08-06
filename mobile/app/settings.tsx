import React, { useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { organizations } from '../src/api/endpoints';
import { API_BASE_URL, errorMessage } from '../src/api/client';
import { ROLE_LABELS } from '../src/api/types';
import { useAuth, useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, spacing } from '../src/theme';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Loading,
  RowDivider,
  SectionLabel,
} from '../src/ui/components';
import type { Organization, OrganizationUpdate, Role } from '../src/api/types';

/** The server's own slug rule; validating here saves a round trip and a 422. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

interface Form {
  name: string;
  slug: string;
  currency: string;
  /** Held as a percentage string — see `toFraction`. */
  vatPercent: string;
}

export default function SettingsScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const canWrite = useCan('settings.write');

  const [draft, setDraft] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => organizations.current(),
  });

  const seeded = useMemo(() => (org.data ? toForm(org.data) : null), [org.data]);
  const form = draft ?? seeded;

  if (org.isPending) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading organisation" />
      </SafeAreaView>
    );
  }

  if (org.isError || !org.data || !form) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="cloud-off"
          title="Couldn't load settings"
          hint={org.error ? errorMessage(org.error) : 'The organisation record is unavailable.'}
          action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void org.refetch()} />}
        />
      </SafeAreaView>
    );
  }

  const current = org.data;

  function set(patch: Partial<Form>) {
    setDraft({ ...(form as Form), ...patch });
  }

  const vatNumber = Number(form.vatPercent);
  const vatValid =
    form.vatPercent.trim() !== '' && Number.isFinite(vatNumber) && vatNumber >= 0 && vatNumber <= 100;

  const errors = {
    name: form.name.trim() ? null : 'The organisation needs a name.',
    slug: SLUG_PATTERN.test(form.slug.trim())
      ? null
      : 'Lowercase letters, digits and hyphens only — no spaces.',
    currency:
      form.currency.length >= 1 && form.currency.length <= 4
        ? null
        : 'Between one and four characters.',
    vat: vatValid ? null : 'Enter a percentage between 0 and 100.',
  };
  const invalid = Object.values(errors).some(Boolean);

  const nextVatRate = vatValid ? toFraction(vatNumber) : current.vat_rate;
  const changed = {
    name: form.name.trim() !== current.name,
    slug: form.slug.trim() !== current.slug,
    currency: form.currency !== current.currency_symbol,
    // Float compare with a tolerance: 16 / 100 and a stored 0.16 must count as
    // the same rate, or every save would resend the VAT rate.
    vat: Math.abs(nextVatRate - current.vat_rate) > 1e-9,
  };
  const dirty = Object.values(changed).some(Boolean);

  function confirmAndSave() {
    if (invalid || !dirty) return;

    if (changed.vat) {
      Alert.alert(
        'Change the VAT rate?',
        `VAT goes from ${toPercentString(current.vat_rate)}% to ${toPercentString(nextVatRate)}%.\n\n` +
          'This changes the tax on future sales only. Receipts already issued keep the rate they were charged at.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change VAT rate', style: 'destructive', onPress: () => void save() },
        ]
      );
      return;
    }

    void save();
  }

  async function save() {
    const f = form as Form;
    // Only what actually moved goes up: the endpoint is a partial update, and
    // resending untouched fields would clobber a concurrent change by another
    // admin.
    const patch: OrganizationUpdate = {
      ...(changed.name ? { name: f.name.trim() } : {}),
      ...(changed.slug ? { slug: f.slug.trim() } : {}),
      ...(changed.currency ? { currency_symbol: f.currency } : {}),
      ...(changed.vat ? { vat_rate: nextVatRate } : {}),
    };

    setBusy(true);
    try {
      const updated = await organizations.update(patch);
      queryClient.setQueryData(['organization'], updated);
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
      setDraft(null); // reseed the form from what the server actually stored
      Alert.alert('Settings saved', `${updated.name} has been updated.`);
    } catch (err) {
      Alert.alert('Couldn’t save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const role = user ? (ROLE_LABELS[user.role as Role] ?? user.role) : '—';
  const appVersion = Constants.expoConfig?.version;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={org.isRefetching}
            onRefresh={() => void org.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        {!canWrite ? (
          <View style={styles.notice}>
            <Icon name="lock" size={16} color={colors.textMuted} />
            <Text style={styles.noticeText}>
              These are the settings your sales are taxed and labelled by. Only an administrator can
              change them.
            </Text>
          </View>
        ) : null}

        <View>
          <SectionLabel>Organisation</SectionLabel>
          <Card style={{ gap: spacing.lg }}>
            <Field
              label="Name"
              value={form.name}
              onChangeText={(name) => set({ name })}
              placeholder="Nkwazi General Stores"
              editable={canWrite}
              error={canWrite ? errors.name : null}
            />
            <Field
              label="Slug"
              value={form.slug}
              onChangeText={(slug) => set({ slug: slug.toLowerCase() })}
              placeholder="nkwazi-general"
              autoCapitalize="none"
              editable={canWrite}
              error={canWrite ? errors.slug : null}
              hint="Used in links and references. Lowercase letters, digits and hyphens."
            />
            <Field
              label="Currency symbol"
              value={form.currency}
              onChangeText={(currency) => set({ currency: currency.slice(0, 4) })}
              placeholder="K"
              autoCapitalize="characters"
              editable={canWrite}
              error={canWrite ? errors.currency : null}
              hint="Shown on receipts and invoices."
            />
          </Card>
        </View>

        <View>
          <SectionLabel>Tax</SectionLabel>
          <Card style={{ gap: spacing.lg }}>
            <Field
              label="VAT rate"
              value={form.vatPercent}
              onChangeText={(vatPercent) => set({ vatPercent })}
              placeholder="16"
              keyboardType="decimal-pad"
              editable={canWrite}
              error={canWrite ? errors.vat : null}
              hint="Entered as a percentage. Applies to future sales only."
            />
            <View style={styles.vatPreview}>
              <Text style={styles.vatPreviewLabel}>Charged on a taxable sale</Text>
              <Text style={styles.vatPreviewValue}>
                {vatValid ? `${trimZeros(vatNumber)}%` : '—'}
              </Text>
            </View>
          </Card>
        </View>

        {canWrite ? (
          <Button
            label={dirty ? 'Save Changes' : 'No Changes'}
            icon="save"
            size="lg"
            loading={busy}
            disabled={!dirty || invalid}
            onPress={confirmAndSave}
          />
        ) : null}

        <View>
          <SectionLabel>About</SectionLabel>
          <Card>
            <AboutRow icon="user" label="Signed in as" value={user?.full_name ?? 'Unknown'} />
            <RowDivider />
            <AboutRow icon="mail" label="Email" value={user?.email ?? '—'} />
            <RowDivider />
            <AboutRow icon="shield" label="Role" value={role} badge />
            <RowDivider />
            <AboutRow icon="home" label="Organisation" value={current.name} />
            <RowDivider />
            {/* The single most useful line when a build is pointed at the wrong
                server — selectable so it can be pasted into a bug report. */}
            <AboutRow icon="server" label="API server" value={API_BASE_URL} wrap />
            {appVersion ? (
              <>
                <RowDivider />
                <AboutRow icon="tag" label="App version" value={appVersion} />
              </>
            ) : null}
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function AboutRow({
  icon,
  label,
  value,
  wrap,
  badge,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  value: string;
  wrap?: boolean;
  badge?: boolean;
}) {
  return (
    <View style={[styles.aboutRow, wrap && { alignItems: 'flex-start' }]}>
      <View style={styles.aboutIcon}>
        <Icon name={icon} size={14} color={colors.primary} />
      </View>
      <Text style={styles.aboutLabel}>{label}</Text>
      <View style={styles.aboutValueWrap}>
        {badge ? (
          <Badge label={value} tone="accent" />
        ) : (
          <Text
            style={styles.aboutValue}
            numberOfLines={wrap ? 3 : 1}
            selectable={wrap}
          >
            {value}
          </Text>
        )}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------- VAT plumbing */

/**
 * The API stores VAT as a fraction (0.16) while people say "16%". Every read
 * multiplies by 100 and every write divides by it — getting this backwards
 * would mis-tax every future sale by a factor of a hundred without any error.
 */
function toPercentString(fraction: number): string {
  return trimZeros(Math.round(fraction * 10000) / 100);
}

function toFraction(percent: number): number {
  return Math.round(percent * 10000) / 1_000_000;
}

function trimZeros(n: number): string {
  return String(Number(n.toFixed(4)));
}

function toForm(org: Organization): Form {
  return {
    name: org.name,
    slug: org.slug,
    currency: org.currency_symbol,
    vatPercent: toPercentString(org.vat_rate),
  };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.textMuted, lineHeight: 18 },

  vatPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  vatPreviewLabel: { fontFamily: font.medium, fontSize: 12, color: colors.accentDeep, flexShrink: 1 },
  vatPreviewValue: { fontFamily: font.extrabold, fontSize: 18, color: colors.accentDeep },

  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  aboutIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutLabel: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted },
  aboutValueWrap: { flex: 1, alignItems: 'flex-end' },
  aboutValue: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
});
