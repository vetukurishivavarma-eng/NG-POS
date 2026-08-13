import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { appUpdates } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { installedBuild, installedVersion, useAppUpdate } from '../src/store/appUpdate';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, spacing } from '../src/theme';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  RowDivider,
  SectionLabel,
  StatRow,
  Toggle,
} from '../src/ui/components';

/**
 * Publishing a build, and what that does to every handset.
 *
 * There is no app store in this loop. The APK is put somewhere the shops can
 * reach — GitHub Releases, a Drive link, the organisation's own site — and this
 * screen records that it exists. Every app then finds out on its next check,
 * because checking is the app's job and this row is the only thing it consults.
 *
 * The consequences are stated on the screen rather than left in a manual. An
 * administrator setting "Required immediately" is deciding that a shop with the
 * old build stops selling, and they should be reading that sentence while they
 * decide it.
 */
export default function AppReleasesScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();

  const currentBuild = installedBuild();

  const [version, setVersion] = useState('');
  const [build, setBuild] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const releases = useQuery({
    queryKey: ['app-releases'],
    queryFn: () => appUpdates.releases(),
  });

  const publish = useMutation({
    mutationFn: () =>
      appUpdates.publish({
        version: version.trim(),
        build: Number(build),
        download_url: url.trim(),
        notes: notes.trim(),
        mandatory,
        // The floor is the build itself when the update is compulsory: anything
        // older is locked out at once. Otherwise no floor, and the two
        // postponements apply.
        minimum_build: mandatory ? Number(build) : 0,
        grace_count: 2,
      }),
    onSuccess: () => {
      setVersion('');
      setBuild('');
      setUrl('');
      setNotes('');
      setMandatory(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['app-releases'] });
      Alert.alert(
        'Published',
        'Every device will be told about this build the next time it opens the app, or within half an hour if it is already open.'
      );
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const retire = useMutation({
    mutationFn: (id: string) => appUpdates.update(id, { is_active: false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['app-releases'] }),
    onError: (err) => Alert.alert('Could not withdraw', errorMessage(err)),
  });

  const buildNumber = Number(build);
  const valid =
    version.trim().length > 0 &&
    Number.isInteger(buildNumber) &&
    buildNumber > 0 &&
    /^https?:\/\/\S+$/i.test(url.trim());

  const submit = () => {
    if (!valid) {
      setError('A version name, a whole build number and a full download link are all needed.');
      return;
    }
    if (currentBuild !== null && buildNumber <= currentBuild) {
      // Publishing a build at or below the one in your hand would tell every
      // device it is already current, and the update nobody asked for would be
      // the one that never arrives.
      setError(
        `Build ${buildNumber} is not newer than the build you are running (${currentBuild}). Raise versionCode in app.json and rebuild.`
      );
      return;
    }
    if (mandatory) {
      Alert.alert(
        'Force this update?',
        'Every device on an older build will be stopped at the update screen with no way past it until the new APK is installed. Tills will not be able to sell until then.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Publish as required', style: 'destructive', onPress: () => publish.mutate() },
        ]
      );
      return;
    }
    publish.mutate();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl }}>
        <Card style={styles.card}>
          <SectionLabel>This device</SectionLabel>
          <StatRow label="Version" value={installedVersion() || '—'} />
          <RowDivider />
          <StatRow label="Build" value={currentBuild === null ? 'unknown' : String(currentBuild)} />
          <RowDivider />
          <StatRow
            label="Postponements used"
            value={String(useAppUpdate.getState().skipsUsed)}
          />
          <Button
            label="Check for updates now"
            icon="refresh-cw"
            variant="secondary"
            style={{ marginTop: spacing.md }}
            onPress={() => {
              void useAppUpdate
                .getState()
                .check({ force: true })
                .then(() => {
                  const { status, release } = useAppUpdate.getState();
                  if (status === 'none') Alert.alert('Up to date', 'This is the current build.');
                  else if (release) {
                    Alert.alert('Update available', `Version ${release.version} is ready to install.`);
                  }
                });
            }}
          />
        </Card>

        <SectionLabel>Publish a build</SectionLabel>
        <Card style={styles.card}>
          <Field
            label="Version name"
            placeholder="1.1.0"
            value={version}
            onChangeText={setVersion}
            autoCapitalize="none"
            hint="What people read. Any format you like."
          />
          <Field
            label="Build number"
            placeholder="2"
            value={build}
            onChangeText={setBuild}
            keyboardType="number-pad"
            hint="The android.versionCode from app.json. This is the number that is actually compared, and it must go up every release."
          />
          <Field
            label="Download link"
            placeholder="https://github.com/…/ng-pos.apk"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            hint="A direct link to the APK. GitHub Releases works well and costs nothing."
          />
          <Field
            label="What's new"
            placeholder="Faster stock sync; transfer notes now print."
            value={notes}
            onChangeText={setNotes}
            multiline
            hint="Shown on the update prompt. Worth writing — it is the reason somebody taps Update instead of Later."
          />

          <Toggle
            label="Required immediately"
            value={mandatory}
            onChange={setMandatory}
            hint="No 'Later' at all. Use it for a release that fixes something the shops must not keep running on. Otherwise everyone gets two postponements before the update becomes compulsory."
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            label="Publish"
            icon="upload-cloud"
            onPress={submit}
            loading={publish.isPending}
            style={{ marginTop: spacing.md }}
          />
        </Card>

        <SectionLabel>Published</SectionLabel>
        {releases.isLoading ? (
          <Loading />
        ) : releases.data && releases.data.length > 0 ? (
          releases.data.map((release) => (
            <Card key={release.id} style={styles.card}>
              <View style={styles.releaseHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.releaseVersion}>
                    {release.version}{' '}
                    <Text style={styles.releaseBuild}>build {release.build}</Text>
                  </Text>
                  <Text style={styles.releaseMeta}>
                    {new Date(release.published_at).toLocaleDateString()} ·{' '}
                    {release.published_by || 'unknown'}
                  </Text>
                </View>
                {release.build === currentBuild ? (
                  <Badge label="Running here" tone="success" />
                ) : !release.is_active ? (
                  <Badge label="Withdrawn" tone="neutral" />
                ) : release.mandatory ? (
                  <Badge label="Required" tone="danger" />
                ) : (
                  <Badge label="Live" tone="accent" />
                )}
              </View>

              {release.notes ? <Text style={styles.releaseNotes}>{release.notes}</Text> : null}

              <Text style={styles.releaseUrl} numberOfLines={1} selectable>
                {release.download_url}
              </Text>

              {release.is_active ? (
                <Button
                  label="Withdraw"
                  icon="slash"
                  variant="ghost"
                  onPress={() =>
                    Alert.alert(
                      'Withdraw this release?',
                      'Devices will stop being offered it. Anyone already running it keeps it — this only stops it being handed out.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Withdraw', style: 'destructive', onPress: () => retire.mutate(release.id) },
                      ]
                    )
                  }
                />
              ) : null}
            </Card>
          ))
        ) : (
          <EmptyState
            icon="package"
            title="Nothing published yet"
            hint="Until a build is published every device is treated as current, so nobody is ever locked out by an empty list."
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  card: { marginBottom: spacing.lg, gap: spacing.sm },

  error: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.danger,
    lineHeight: 19,
    marginTop: spacing.sm,
  },

  releaseHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  releaseVersion: { fontFamily: font.bold, fontSize: 16, color: colors.ink },
  releaseBuild: { fontFamily: font.regular, fontSize: 13, color: colors.textFaint },
  releaseMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  releaseNotes: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: colors.text },
  releaseUrl: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
