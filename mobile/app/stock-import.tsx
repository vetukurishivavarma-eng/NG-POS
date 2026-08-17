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
import { useStoreSelection } from '../src/store/storeSelection';
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
 * Loading a shop's whole catalogue and its opening stock from one spreadsheet.
 *
 * Three deliberate steps — pick, check, apply — because this writes hundreds of
 * rows at once and there is no undo. The check is a real server-side dry run,
 * not a guess made on the device: it reports the exact stock level every product
 * would move from and to, which shop columns it recognised, and changes nothing.
 */
export default function StockImportScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const store = useStoreSelection((s) => s.selected);
  const canImport = useCan('products.import');
  const storeId = store?.id ?? null;

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
    if (!file || !storeId) return;
    setBusy(true);
    setErrors(null);
    setErrorDetail(null);
    try {
      const result = await inventoryApi.bulkUpload({
        store_id: storeId,
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

  function confirmApply() {
    if (!checked) return;
    Alert.alert(
      `Import ${checked.total_rows} rows into ${store?.name}?`,
      `${checked.products_to_create} product${checked.products_to_create === 1 ? '' : 's'} will be created and ${checked.products_to_update} updated. ${
        mode === 'set'
          ? 'Stock levels become the quantities in the file.'
          : 'The quantities in the file are added to what is already there.'
      } There is no undo.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import', onPress: () => void apply() },
      ]
    );
  }

  async function apply() {
    if (!file || !storeId) return;
    setBusy(true);
    try {
      const result = await inventoryApi.bulkUpload({
        store_id: storeId,
        ...payloadFor(file),
        mode,
        note: `Imported from ${file.name}`,
      });

      void queryClient.invalidateQueries({ queryKey: ['catalogue', storeId] });
      void queryClient.invalidateQueries({ queryKey: ['movements', storeId] });
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

  function chooseTemplate() {
    Alert.alert(
      'Which template?',
      'The price list is the sheet the buyer keeps — company, product, pack size, and a price column for each of your shops. The coded sheet is for a catalogue that already has product codes.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Price list', onPress: () => void shareTemplate('price-master') },
        { text: 'Coded sheet', onPress: () => void shareTemplate('sku') },
      ]
    );
  }

  async function shareTemplate(format: 'price-master' | 'sku') {
    setBusy(true);
    try {
      const text = await inventoryApi.bulkUploadTemplate(format);
      const dir = new Directory(Paths.cache, 'templates');
      if (!dir.exists) dir.create({ intermediates: true });

      const name =
        format === 'sku' ? 'ng-pos-stock-template.csv' : 'ng-pos-price-list.csv';
      const target = new File(dir, name);
      if (target.exists) target.delete();
      target.create();
      target.write(text);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target.uri, {
          mimeType: 'text/csv',
          dialogTitle: 'NG POS stock template',
        });
      } else {
        Alert.alert('Template saved', `Saved to ${target.uri}`);
      }
    } catch (err) {
      Alert.alert("Couldn't fetch the template", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The other direction: the catalogue as it stands, to fill in and send back.
   *
   * The two choices are not cosmetic. A price list carries no quantity column
   * at all, so returning it cannot touch a single shelf; a stock count sheet
   * carries this shop's counted numbers, and uploading that back with "Counted
   * on the shelf" set writes them in as the truth. Anyone downloading the price
   * list to fill in buying prices wants the first one, and would not find out
   * they had the second until a week of sales went missing.
   */
  function chooseExport() {
    Alert.alert(
      'Download the current list',
      'The price list has every product with the prices as they stand now — fill in the cost prices and upload the same file back. The stock count sheet adds what this shop currently has on the shelf.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Price list', onPress: () => void shareExport(false) },
        { text: 'With stock counts', onPress: () => void shareExport(true) },
      ]
    );
  }

  async function shareExport(includeStock: boolean) {
    setBusy(true);
    try {
      const text = await inventoryApi.exportCatalogue(storeId, includeStock);

      // A header row and nothing under it. Sharing that would look like the
      // export failed quietly, so it is said plainly instead.
      if (text.split(/\r?\n/).filter((line) => line.trim() !== '').length < 2) {
        Alert.alert(
          'Nothing to download yet',
          'There are no products in the catalogue. Upload a spreadsheet first, then download it back to fill in the prices.'
        );
        return;
      }

      const dir = new Directory(Paths.cache, 'exports');
      if (!dir.exists) dir.create({ intermediates: true });

      const day = new Date().toISOString().slice(0, 10);
      const name = includeStock
        ? `ng-pos-stock-count-${day}.csv`
        : `ng-pos-price-list-${day}.csv`;
      const target = new File(dir, name);
      if (target.exists) target.delete();
      target.create();
      target.write(text);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target.uri, {
          mimeType: 'text/csv',
          dialogTitle: includeStock ? 'NG POS stock count' : 'NG POS price list',
        });
      } else {
        Alert.alert('Saved', `Saved to ${target.uri}`);
      }
    } catch (err) {
      Alert.alert("Couldn't download the list", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="home"
          title="No shop selected"
          hint="Stock is held per shop. Choose the one this spreadsheet belongs to."
          action={
            <Button
              label="Choose shop"
              icon="home"
              variant="secondary"
              onPress={() => router.push('/store-picker')}
            />
          }
        />
      </SafeAreaView>
    );
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
            Excel or CSV. A sheet with no product codes is matched on company, product and pack
            size, so a second upload of a corrected file updates the same rows instead of
            duplicating them.
          </Text>
        </View>

        <View style={styles.shopTag}>
          <Icon name="home" size={14} color={colors.primary} />
          <Text style={styles.shopTagText}>Loading into {store.name}</Text>
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
            onPress={chooseTemplate}
          />
          <Button
            label="Download the Current List"
            icon="share"
            variant="secondary"
            loading={busy && !file}
            onPress={chooseExport}
          />
          <Text style={styles.hint}>
            Uploaded the stock with no prices? Have the shops type the selling prices in, then
            download the current list, fill in the cost prices beside them and upload the same file
            back.
          </Text>
          <Text style={styles.hint}>
            An <Text style={styles.mono}>.xlsx</Text> goes up as it is — no need to save it as CSV
            first. Keep the header row; every line needs a{' '}
            <Text style={styles.mono}>PRODUCT</Text> (or an <Text style={styles.mono}>sku</Text>, on
            a coded sheet).
          </Text>
        </View>

        {/* ------------------------------------------------------ 2. the mode */}
        {file ? (
          <View style={{ gap: spacing.md }}>
            <SectionLabel>Step 2 · What the quantity means</SectionLabel>
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
                  ? 'The stock level becomes the number in the file. This is what an opening stock take means, and it is safe to re-run.'
                  : 'The number in the file is added to what is already there. Running it twice adds it twice.'
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
                <StatRow label="Stock levels touched" value={String(checked.stock_rows)} />
                {checked.shop_columns.length > 0 ? (
                  <StatRow
                    label="Shop prices to set"
                    value={String(checked.shop_prices_to_write)}
                  />
                ) : null}

                {/* Which shops the file prices, and which it cannot. A column
                    that quietly did nothing is the worst way this can fail. */}
                {checked.shop_columns.length > 0 ? (
                  <>
                    <View style={styles.previewDivider} />
                    <Text style={styles.previewLabel}>Shop price columns</Text>
                    {checked.shop_columns.map((column) => (
                      <View key={column.column} style={styles.shopRow}>
                        <Text style={styles.shopName} numberOfLines={1}>
                          {column.column}
                        </Text>
                        <Text style={styles.shopCount}>{column.values} priced</Text>
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

  return (
    <View style={styles.preview}>
      <View style={{ flex: 1 }}>
        <Text style={styles.previewName} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.previewSku} numberOfLines={1}>
          {row.sku} · {row.product_action === 'create' ? 'new product' : 'existing'}
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
