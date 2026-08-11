import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Renders HTML to a PDF and hands it to the share sheet.
 *
 * `printToFileAsync` writes to a cache file with a random name, which is what
 * the receiving app shows to whoever it is sent to — so the file is moved to a
 * name that means something (`Transfer-TRF-M8X2K1.pdf`) before it is shared.
 * Cache is the right home for it: these are re-creatable from live data, and
 * the OS may reclaim them.
 */
export async function shareHtmlAsPdf(
  html: string,
  filename: string,
  dialogTitle: string
): Promise<{ uri: string; shared: boolean }> {
  const { uri } = await Print.printToFileAsync({ html });

  const dir = new Directory(Paths.cache, 'documents');
  if (!dir.exists) dir.create({ intermediates: true });

  const target = new File(dir, safeName(filename));

  // `overwrite` because a second print of the same transfer must replace the
  // first rather than fail on the name clash.
  const generated = new File(uri);
  await generated.move(target, { overwrite: true });

  // Whether the sheet opened is the caller's business: with no share target the
  // file still exists, and the user needs telling where it went rather than
  // watching the button do nothing.
  if (!(await Sharing.isAvailableAsync())) return { uri: target.uri, shared: false };

  await Sharing.shareAsync(target.uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle,
  });
  return { uri: target.uri, shared: true };
}

function safeName(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = cleaned || 'document.pdf';
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}
