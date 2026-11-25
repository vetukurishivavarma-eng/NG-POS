import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { statementCsv, type StatementData } from './statement';
import { shareStatementPdf } from './print';

export async function shareStatementCsv(data: StatementData, filename: string): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, 'sheets');
    if (!dir.exists) dir.create({ intermediates: true });
    const name = filename.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.(pdf|csv)$/i, '') + '.csv';
    const target = new File(dir, name);
    if (target.exists) target.delete();
    target.create();
    target.write(statementCsv(data));

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(target.uri, { mimeType: 'text/csv', dialogTitle: `${data.title} — ${data.subject}` });
    } else {
      Alert.alert('Saved', `Saved to ${target.uri}`);
    }
  } catch (err) {
    Alert.alert("Couldn't export that", err instanceof Error ? err.message : 'The sheet could not be written.');
  }
}

/** The PDF and Excel buttons share one table; this picks the output. */
export function shareStatement(format: 'pdf' | 'csv', data: StatementData, filename: string): Promise<void> {
  return format === 'csv' ? shareStatementCsv(data, filename) : shareStatementPdf(data, filename);
}
