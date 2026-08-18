import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { inventory as inventoryApi } from '../src/api/endpoints';
import { errorBodyIfStatus, errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../src/theme';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  SectionLabel,
  Select,
  StatRow,
} from '../src/ui/components';
import type {
  BulkUploadMode,
  BulkUploadRejection,
  BulkUploadResult,
  BulkUploadRowPreview,
} from '../src/api/types';

type RowError = BulkUploadRejection['errors'][number];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The file, however it arrived. An .xlsx goes up as bytes and is read on the
 * server; anything else is treated as text.
 *
 * Both are kept in one shape so the rest of the screen — check, apply, the row
 * count — does not care which was picked.
 */
type PickedFile =
  | { kind: 'csv'; name: string; text: string }
  | { kind: 'xlsx'; name: string; base64: string; sizeBytes: number };

/** What the request body carries for this file. */
function payloadFor(file: PickedFile): { csv: string } | { xlsx_base64: string } {
  return file.kind === 'csv' ? { csv: file.text } : { xlsx_base64: file.base64 };
}

/**
 * A line under the file name confirming we read what they think they picked.
 *
 * A workbook's rows cannot be counted without parsing it, which is the server's
 * job — so it reports its size instead of guessing. The real row count comes
 * back from the check a moment later either way.
 */
function describeFile(file: PickedFile): string {
  if (file.kind === 'xlsx') return `Excel workbook · ${Math.max(1, Math.round(file.sizeBytes / 1024))} KB`;
  const lines = file.text.split(/\r\n|\r|\n/).filter((l) => l.trim()).length - 1;
  return `CSV · ${Math.max(0, lines)} data rows`;
}

/**
 * Loading the whole chain's catalogue, closing stock and prices from one
 * spreadsheet.
 *
 * Nothing here asks which shop. The file says so itself, twice per shop —
 * "Lusaka Closing Stock" is what is on Lusaka's shelf tonight and "Lusaka SP
 * Per Stock" is what Lusaka charges — so thirteen shops are one upload rather
 * than thirteen, each with a shop to pick correctly first.
 *
 * Three deliberate steps — pick, check, apply — because this writes thousands
 * of rows at once and there is no undo. The check is a real server-side dry
 * run, not a guess made on the device: it reports the exact stock level every
 * product would move from and to, which shop columns it recognised and which it
 * could not, and changes nothing.
 */
export default function StockImportScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const canImport = useCan('products.import');

  const [file, setFile] = useState<PickedFile | null>(null);
  const [mode, setMode] = useState<BulkUploadMode>('set');
  const [checked, setChecked] = useState<BulkUploadResult | null>(null);
  const [errors, setErrors] = useState<RowError[] | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setChecked(null);
    setErrors(null);
    setErrorDetail(null);
  }

  async function pickFile() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        // Android's file browser hands spreadsheets a range of MIME types
        // depending on what created them, and a strict filter simply greys them
        // out. Ask for anything and work out what it is from the bytes.
        type: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv',
          'text/comma-separated-values',
          'text/plain',
          '*/*',
        ],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.[0]) return;

      const asset = picked.assets[0];
      const handle = new File(asset.uri);
      const name = asset.name.toLowerCase();

      if (name.endsWith('.xls')) {
        Alert.alert(
          'That is the older Excel format',
          'Open it in Excel and use Save As → Excel Workbook (.xlsx), then pick it again.'
        );
        return;
      }

      const asWorkbook = async () =>
        setFile({
          kind: 'xlsx',
          name: asset.name,
          base64: await handle.base64(),
          sizeBytes: handle.size,
        });

      if (name.endsWith('.xlsx') || asset.mimeType === XLSX_MIME) {
        await asWorkbook();
      } else {
        const text = await handle.text();

        // An .xlsx is a zip, and every zip starts "PK". Files picked from Drive
        // come back under names like `document/1234` with no useful extension
        // or MIME type, so the bytes are the only reliable answer.
        if (text.startsWith('PK')) {
          await asWorkbook();
        } else if (!text.trim()) {
          Alert.alert('That file is empty', 'Pick the spreadsheet again.');
          return;
        } else {
          setFile({ kind: 'csv', name: asset.name, text });
        }
      }

      setChecked(null);
      setErrors(null);
      setErrorDetail(null);
    } catch (err) {
      Alert.alert("Couldn't read that file", errorMessage(err));
    }
  }

  async function check() {
    if (!file) return;
    setBusy(true);
    setErrors(null);
    setErrorDetail(null);
    try {
      const result = await inventoryApi.bulkUpload({
        ...payloadFor(file),
        mode,
        validate_only: true,
      });
      setChecked(result);
    } catch (err) {
      captureRejection(err);
      setChecked(null);
    } finally {
      setBusy(false);
    }
  }

  /** One line describing what the import does, shared by both confirmations. */
  function importSummary(result: BulkUploadResult): string {
    return (
      `${result.products_to_create} product${result.products_to_create === 1 ? '' : 's'} will be created and ${result.products_to_update} updated` +
      (result.shops_counted > 0
        ? `, across ${result.shops_counted} shop${result.shops_counted === 1 ? '' : 's'}`
        : '') +
      `. ${
        mode === 'set'
          ? 'Each shop’s stock becomes its Closing Stock column.'
          : 'Each shop’s Closing Stock column is added to what is already there.'
      } There is no undo.`
    );
  }

  /**
   * Rows the file lists but never counts.
   *
   * There are two honest readings of an empty Closing Stock column and only the
   * person holding the sheet knows which is meant: either the file is silent
   * about those products, or those products have run out. Guessing the second
   * would empty shelves nobody asked about; guessing the first leaves an
   * empty shelf reading as full at the till. So it is asked, with the product
   * names in the question — four names someone recognises is worth more than a
   * count they will wave through.
   */
  function confirmApply() {
    if (!checked) return;

    if (checked.rows_without_stock === 0) {
      Alert.alert(`Import ${checked.total_rows} rows?`, importSummary(checked), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import', onPress: () => void apply(false) },
      ]);
      return;
    }

    const names = checked.products_without_stock;
    const shown = names.slice(0, 6).join(', ');
    const rest = checked.rows_without_stock - Math.min(names.length, 6);

    Alert.alert(
      `${checked.rows_without_stock} product${checked.rows_without_stock === 1 ? ' has' : 's have'} no stock in the file`,
      `${shown}${rest > 0 ? `, and ${rest} more` : ''}.\n\n` +
        'Their Closing Stock cells are empty. Mark them out of stock, or leave their current ' +
        `stock as it is?\n\n${importSummary(checked)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave as they are', onPress: () => void apply(false) },
        { text: 'Mark out of stock', onPress: () => void apply(true) },
      ]
    );
  }

  async function apply(zeroMissingStock: boolean) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await inventoryApi.bulkUpload({
        ...payloadFor(file),
        mode,
        zero_missing_stock: zeroMissingStock,
        note: `Imported from ${file.name}`,
      });

      // Every shop's shelf may have moved, so the whole key is invalidated
      // rather than one store's branch of it.
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
      void queryClient.invalidateQueries({ queryKey: ['movements'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });

      reset();
      Alert.alert('Import complete', result.detail, [
        { text: 'Done', onPress: () => router.back() },
        { text: 'Import another' },
      ]);
    } catch (err) {
      captureRejection(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * A 422 carries the line numbers that could not be read, and means nothing
   * was written. Anything else is an ordinary failure with one message.
   */
  function captureRejection(err: unknown) {
    const rejection = errorBodyIfStatus<BulkUploadRejection>(err, 422);
    if (rejection && Array.isArray(rejection.errors)) {
      setErrors(rejection.errors);
      setErrorDetail(rejection.detail ?? 'The file could not be read.');
      return;
    }
    Alert.alert("The import didn't run", errorMessage(err));
  }

  /**
   * The two downloads, which are the same document twice: the template is the
   * blank one and the current list is the filled-in one, column for column.
   *
   * There used to be a dialog in front of each of these offering two shapes,
   * and picking wrong was silent — a shop that took the price list to send its
   * counts back had a file with no stock column in it, and found out a week
   * later when nothing had moved. One shape, no dialog.
   */
  async function downloadTemplate() {
    await saveAndShare(
      () => inventoryApi.bulkUploadTemplate(),
      'ng-pos-stock-template.csv',
      'NG POS stock template'
    );
  }

  async function downloadCurrentList() {
    const day = new Date().toISOString().slice(0, 10);
    await saveAndShare(
      async () => {
        const text = await inventoryApi.exportCatalogue();
        // A header row and nothing under it. Sharing that would look like the
        // download failed quietly, so it is said plainly instead.
        if (text.split(/\r?\n/).filter((line) => line.trim() !== '').length < 2) {
          throw new Error(
            'There are no products yet. Upload a filled-in template first, then download the current list.'
          );
        }
        return text;
      },
      `ng-pos-stock-list-${day}.csv`,
      'NG POS stock list'
    );
  }

  /** Fetch a CSV, put it in the cache directory, and hand it to the share sheet. */
  async function saveAndShare(
    fetchCsv: () => Promise<string>,
    name: string,
    dialogTitle: string
  ) {
    setBusy(true);
    try {
      const text = await fetchCsv();

      const dir = new Directory(Paths.cache, 'sheets');
      if (!dir.exists) dir.create({ intermediates: true });

      const target = new File(dir, name);
      if (target.exists) target.delete();
      target.create();
      target.write(text);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target.uri, { mimeType: 'text/csv', dialogTitle });
      } else {
        Alert.alert('Saved', `Saved to ${target.uri}`);
      }
    } catch (err) {
      Alert.alert("Couldn't download that", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canImport) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Read-only for your role"
          hint="Only a store manager or an administrator can load stock in bulk."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Text style={styles.title}>Load stock from a spreadsheet</Text>
          <Text style={styles.lead}>
            Excel or CSV. No shop to choose — each shop has its own two columns in the file, and a
            second upload of a corrected file updates the same rows instead of duplicating them.
          </Text>
        </View>

        <View style={styles.shopTag}>
          <Icon name="home" size={14} color={colors.primary} />
          <Text style={styles.shopTagText}>Every shop you cover, one file</Text>
        </View>

        {/* ------------------------------------------------------ 1. the file */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>Step 1 · The file</SectionLabel>

          {file ? (
            <View style={styles.fileCard}>
              <View style={styles.fileIcon}>
                <Icon name="file-text" size={19} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {file.name}
                </Text>
                <Text style={styles.fileMeta}>{describeFile(file)}</Text>
              </View>
              <Button label="Change" variant="secondary" onPress={() => void pickFile()} />
            </View>
          ) : (
            <Button label="Choose Excel or CSV" icon="upload" onPress={() => void pickFile()} />
          )}

          <Button
            label="Get a Blank Template"
            icon="download"
            variant="secondary"
            loading={busy && !file}
            onPress={() => void downloadTemplate()}
          />
          <Button
            label="Download the Current List"
            icon="share"
            variant="secondary"
            loading={busy && !file}
            onPress={() => void downloadCurrentList()}
          />
          <Text style={styles.hint}>
            Both files have the same columns — the template is the blank one, the current list is
            the same sheet already filled in. Download the current list, correct it in Excel, and
            upload it straight back. An owner's copy covers every shop; a shop's copy covers its
            own lines and its own two columns.
          </Text>
          <Text style={styles.hint}>
            Each shop has two columns:{' '}
            <Text style={styles.mono}>Lusaka Closing Stock</Text> is what is left on Lusaka's shelf,
            and <Text style={styles.mono}>Lusaka SP Per Stock</Text> is what Lusaka sells it for.
            Leave a cell blank to change nothing there.
          </Text>
          <Text style={styles.hint}>
            An <Text style={styles.mono}>.xlsx</Text> goes up as it is — no need to save it as CSV
            first. Keep the header row; every line needs a{' '}
            <Text style={styles.mono}>PRODUCT</Text>. Leave <Text style={styles.mono}>SKU</Text>{' '}
            blank and a code is worked out from the company, product and pack size.
          </Text>
        </View>

        {/* ------------------------------------------------------ 2. the mode */}
        {file ? (
          <View style={{ gap: spacing.md }}>
            <SectionLabel>Step 2 · What Closing Stock means</SectionLabel>
            <Select<BulkUploadMode>
              value={mode}
              onChange={(next) => {
                setMode(next);
                setChecked(null);
              }}
              options={[
                { value: 'set', label: 'Counted on the shelf' },
                { value: 'add', label: 'A delivery to add on' },
              ]}
              hint={
                mode === 'set'
                  ? "Each shop's stock becomes the number in its Closing Stock column. This is what an end-of-day count means, and it is safe to re-run — but a list downloaded last week will roll the shelves back to last week."
                  : 'The number in each Closing Stock column is added to what that shop already has. Running it twice adds it twice.'
              }
            />
          </View>
        ) : null}

        {/* ----------------------------------------------------- 3. dry run */}
        {file ? (
          <View style={{ gap: spacing.md }}>
            <SectionLabel>Step 3 · Check it</SectionLabel>
            <Button
              label={checked ? 'Check Again' : 'Check the File'}
              icon="search"
              variant={checked ? 'secondary' : 'primary'}
              loading={busy && !checked}
              onPress={() => void check()}
            />

            {errors ? (
              <View style={styles.errorCard}>
                <View style={styles.errorHead}>
                  <Icon name="alert-triangle" size={17} color={colors.danger} />
                  <Text style={styles.errorTitle}>{errorDetail}</Text>
                </View>
                {errors.slice(0, 12).map((e, i) => (
                  <View key={`${e.row}-${i}`} style={styles.errorRow}>
                    <Badge label={`LINE ${e.row}`} tone="danger" />
                    <Text style={styles.errorText}>{e.message}</Text>
                  </View>
                ))}
                {errors.length > 12 ? (
                  <Text style={styles.errorMore}>
                    …and {errors.length - 12} more. Fix the file and check it again.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {checked ? (
              <View style={styles.previewCard}>
                <StatRow label="Rows in the file" value={String(checked.total_rows)} />
                <StatRow label="New products" value={String(checked.products_to_create)} />
                <StatRow label="Existing products updated" value={String(checked.products_to_update)} />
                <StatRow
                  label="Stock levels to set"
                  value={`${checked.shop_stock_writes} across ${checked.shops_counted} shop${
                    checked.shops_counted === 1 ? '' : 's'
                  }`}
                />
                {checked.shop_prices_to_write > 0 ? (
                  <StatRow label="Shop prices to set" value={String(checked.shop_prices_to_write)} />
                ) : null}
                {/* Flagged here as well as in the popup, so it is visible
                    before the operator commits to pressing Import at all. */}
                {checked.rows_without_stock > 0 ? (
                  <StatRow
                    label="No stock in the file"
                    value={`${checked.rows_without_stock} product${
                      checked.rows_without_stock === 1 ? '' : 's'
                    }`}
                  />
                ) : null}

                {/* Which shops the file prices, and which it cannot. A column
                    that quietly did nothing is the worst way this can fail. */}
                {checked.shop_columns.length > 0 ? (
                  <>
                    <View style={styles.previewDivider} />
                    <Text style={styles.previewLabel}>Shop columns</Text>
                    {checked.shop_columns.map((column) => (
                      <View key={column.column} style={styles.shopRow}>
                        <Text style={styles.shopName} numberOfLines={1}>
                          {column.column}
                        </Text>
                        <Text style={styles.shopCount}>
                          {column.values} {column.kind === 'stock' ? 'counted' : 'priced'}
                        </Text>
                        <Badge
                          label={column.status === 'ok' ? 'WILL APPLY' : 'SKIPPED'}
                          tone={column.status === 'ok' ? 'success' : 'warning'}
                        />
                      </View>
                    ))}
                  </>
                ) : null}

                {checked.warnings.length > 0 ? (
                  <View style={styles.warnBox}>
                    {checked.warnings.slice(0, 5).map((w, i) => (
                      <Text key={i} style={styles.warnText}>
                        {w}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {checked.preview && checked.preview.length > 0 ? (
                  <>
                    <View style={styles.previewDivider} />
                    <Text style={styles.previewLabel}>
                      First {checked.preview.length} of {checked.total_rows}
                    </Text>
                    {checked.preview.map((row) => (
                      <PreviewRow key={row.row} row={row} />
                    ))}
                  </>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* -------------------------------------------------------- 4. apply */}
        {checked ? (
          <View style={{ gap: spacing.md }}>
            <SectionLabel>Step 4 · Import it</SectionLabel>
            <Button
              label={`Import ${checked.total_rows} Rows`}
              icon="check"
              size="lg"
              loading={busy}
              onPress={confirmApply}
            />
            <Text style={styles.hint}>
              Everything lands or nothing does. If a line cannot be read the whole file is refused,
              so there is never a half-loaded catalogue to untangle.
            </Text>
          </View>
        ) : null}

        {file ? <Button label="Start Over" variant="ghost" onPress={reset} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function PreviewRow({ row }: { row: BulkUploadRowPreview }) {
  const up = row.change > 0;
  const down = row.change < 0;
  // Totalled across the shops this row counts, which is what the server sends:
  // a per-shop breakdown of 500 rows is not something anyone reads on a phone.

  return (
    <View style={styles.preview}>
      <View style={{ flex: 1 }}>
        <Text style={styles.previewName} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.previewSku} numberOfLines={1}>
          {row.sku} · {row.product_action === 'create' ? 'new product' : 'existing'}
          {row.shops > 0 ? ` · ${row.shops} shop${row.shops === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
      <Text style={styles.previewFrom}>{row.quantity_before}</Text>
      <Icon name="arrow-right" size={13} color={colors.textFaint} />
      <Text
        style={[
          styles.previewTo,
          up && { color: colors.success },
          down && { color: colors.danger },
        ]}
      >
        {row.quantity_after}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  title: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  lead: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: 19,
  },
  hint: { fontFamily: font.regular, fontSize: 12, color: colors.textFaint, lineHeight: 17 },
  mono: { fontFamily: font.semibold, color: colors.textMuted },

  shopTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  shopTagText: { fontFamily: font.semibold, fontSize: 12, color: colors.primary },

  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadow.card,
  },
  fileIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  fileMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },

  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  errorTitle: { flex: 1, fontFamily: font.bold, fontSize: 14, color: colors.danger },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  errorText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.text, lineHeight: 17 },
  errorMore: { fontFamily: font.regular, fontSize: 12, color: colors.danger },

  previewCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
    ...shadow.card,
  },
  previewDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  previewLabel: {
    fontFamily: font.semibold,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 7,
  },
  previewName: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  previewSku: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint, marginTop: 1 },
  previewFrom: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted },
  previewTo: { fontFamily: font.extrabold, fontSize: 15, color: colors.text, minWidth: 34, textAlign: 'right' },

  shopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  shopName: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: colors.text },
  shopCount: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint },

  warnBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
    marginTop: spacing.sm,
  },
  warnText: { fontFamily: font.medium, fontSize: 12, color: colors.warning, lineHeight: 17 },
});
