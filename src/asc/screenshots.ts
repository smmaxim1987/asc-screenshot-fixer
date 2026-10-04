import type { AscClient } from './client.js';
import { mapWithConcurrency } from './concurrency.js';
import type {
  AppRef,
  AppScanResult,
  AssetDeliveryState,
  Screenshot,
  ScreenshotSet,
  ScreenshotVerdict,
} from '../types.js';

/** How long "PROCESSING" is tolerated before counting as stuck: Apple promises minutes, not hours. */
const PROCESSING_STUCK_AFTER_MS = 60 * 60 * 1000;

interface Resource<T> {
  id: string;
  type: string;
  attributes: T;
  relationships?: Record<string, { data?: { id: string; type: string } | null } | undefined>;
}

interface AppAttributes {
  bundleId: string;
  name: string;
  sku?: string | null;
}

interface SetAttributes {
  screenshotDisplayType: string;
  /** Comes back in GET_INSTANCE alongside the version's localization and platform. */
  platform?: string | null;
}

interface ScreenshotAttributes {
  fileName?: string | null;
  fileSize?: number | null;
  /**
   * Important: the API returns an object `{ "state": "COMPLETE" }`, not a string.
   * Some responses do send a bare string, so both shapes are handled.
   */
  assetDeliveryState?: string | { state?: string | null } | null;
  sourceFileChecksum?: string | null;
  imageAsset?: { templateUrl?: string; width?: number; height?: number } | null;
  uploadedAt?: string | null;
  errorMessage?: string | null;
}

/** Extracts the delivery state from a `{state}` object or from a bare string. */
function deliveryStateOf(raw: ScreenshotAttributes['assetDeliveryState']): AssetDeliveryState | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string') {
    return raw as AssetDeliveryState;
  }
  return (raw.state ?? null) as AssetDeliveryState | null;
}

/**
 * States a screenshot can never leave on its own.
 *
 * AWAITING_UPLOAD is the key case: a reservation was created but the file was
 * never uploaded (the connection dropped). In the UI this shows up as a red or
 * empty placeholder with "screenshot uploads in progress", which cannot be
 * cleared by hand.
 */
const STUCK_STATES = new Set<string>([
  'FAILED',
  'EXPIRED',
  'MISSING_UPLOAD',
  'AWAITING_UPLOAD',
]);

export function classify(
  state: AssetDeliveryState | null | undefined,
  uploadedAt: string | null | undefined,
  now = Date.now(),
): ScreenshotVerdict {
  const value = state ?? 'UNKNOWN';

  if (STUCK_STATES.has(value)) {
    return 'stuck';
  }

  if (value === 'PROCESSING' || value === 'UPLOAD_COMPLETE') {
    const since = uploadedAt ? Date.parse(uploadedAt) : NaN;
    return Number.isNaN(since) || now - since > PROCESSING_STUCK_AFTER_MS ? 'stuck' : 'processing';
  }

  if (value === 'COMPLETE') {
    return 'ok';
  }

  // Unknown states are never deleted automatically: showing is safer than deleting.
  return 'ok';
}

/** Apple returns URLs with `{w}x{h}` placeholders — substitute a preview size. */
function replaceTemplate(templateUrl: string): string {
  return templateUrl.replace(/\{w\}/g, '600').replace(/\{h\}/g, '1350');
}

function toScreenshot(resource: Resource<ScreenshotAttributes>, now: number): Screenshot {
  const attributes = resource.attributes;
  const state = deliveryStateOf(attributes.assetDeliveryState);
  const asset = attributes.imageAsset ?? null;

  return {
    id: resource.id,
    fileName: attributes.fileName ?? null,
    fileSize: attributes.fileSize ?? null,
    assetDeliveryState: state ?? 'UNKNOWN',
    verdict: classify(state, attributes.uploadedAt ?? null, now),
    sourceFileChecksum: attributes.sourceFileChecksum ?? null,
    imageAsset: asset?.templateUrl
      ? { templateUrl: asset.templateUrl, width: asset.width ?? 0, height: asset.height ?? 0 }
      : null,
    imageUrl: asset?.templateUrl ? replaceTemplate(asset.templateUrl) : null,
    uploadedAt: attributes.uploadedAt ?? null,
    errorMessage: attributes.errorMessage ?? null,
  };
}

export async function listApps(client: AscClient): Promise<AppRef[]> {
  const apps = await client.getAll<Resource<AppAttributes>>('/v1/apps?limit=200');

  return apps.map((app) => ({
    id: app.id,
    bundleId: app.attributes.bundleId,
    name: app.attributes.name,
    sku: app.attributes.sku ?? null,
  }));
}

export async function findApp(client: AscClient, bundleId: string): Promise<AppRef | null> {
  const filter = `filter[bundleId]=${encodeURIComponent(bundleId)}`;
  const apps = await client.getAll<Resource<AppAttributes>>(`/v1/apps?${filter}&limit=10`);
  const match = apps.find((app) => app.attributes.bundleId === bundleId);

  return match
    ? {
        id: match.id,
        bundleId: match.attributes.bundleId,
        name: match.attributes.name,
        sku: match.attributes.sku ?? null,
      }
    : null;
}

interface VersionAttributes {
  versionString?: string;
  platform?: string;
}

interface LocalizationAttributes {
  locale: string;
}

interface ScreenshotSetLinkage {
  id: string;
  type: string;
}

/**
 * Screenshot sets cannot be fetched with a direct GET_COLLECTION — Apple answers
 * 403 ("appScreenshotSets does not allow GET_COLLECTION"). There is no
 * appScreenshotSets relationship on appStoreVersions either ("relationship
 * 'appScreenshotSets' does not exist"): sets hang off the version localization.
 * The working path is:
 *   apps → appStoreVersions → appStoreVersionLocalizations → appScreenshotSets
 */
export async function listScreenshotSets(
  client: AscClient,
  appId: string,
  signal?: AbortSignal,
): Promise<ScreenshotSet[]> {
  const versions = await client.getAll<Resource<VersionAttributes>>(
    `/v1/apps/${appId}/appStoreVersions?limit=200`,
  );

  const now = Date.now();
  const sets: ScreenshotSet[] = [];

  for (const version of versions) {
    if (signal?.aborted) {
      throw new Error('Scan cancelled');
    }

    const localizations = await client.getAll<Resource<LocalizationAttributes>>(
      `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`,
    );

    await mapWithConcurrency(localizations, 3, async (localization) => {
      // Sets are only readable through a localization — direct GET_COLLECTION is banned.
      const document = await client.getDocument<{ data?: ScreenshotSetLinkage[] }>(
        `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`,
      );

      const links = document.data ?? [];
      if (links.length === 0) {
        return;
      }

      await mapWithConcurrency(links, 5, async (link) => {
        // GET_INSTANCE is the only permitted way to read a set.
        const set = await client.get<Resource<SetAttributes>>(`/v1/appScreenshotSets/${link.id}`);

        const shots = await client.getAll<Resource<ScreenshotAttributes>>(
          `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`,
        );

        sets.push({
          id: set.id,
          screenshotDisplayType: set.attributes.screenshotDisplayType,
          localizationId: localization.id,
          locale: localization.attributes.locale ?? null,
          platform: version.attributes.platform ?? null,
          screenshots: shots.map((shot) => toScreenshot(shot, now)),
        });
      });
    });
  }

  return sets;
}

export async function scanApp(
  client: AscClient,
  app: AppRef,
  signal?: AbortSignal,
): Promise<AppScanResult> {
  const sets = await listScreenshotSets(client, app.id, signal);
  const screenshots = sets.flatMap((set) => set.screenshots);

  return {
    app,
    sets,
    totals: {
      sets: sets.length,
      screenshots: screenshots.length,
      stuck: screenshots.filter((shot) => shot.verdict === 'stuck').length,
      processing: screenshots.filter((shot) => shot.verdict === 'processing').length,
      ok: screenshots.filter((shot) => shot.verdict === 'ok').length,
    },
  };
}

/** Deletes a single stuck screenshot — exactly what the original script does. */
export async function deleteScreenshot(client: AscClient, screenshotId: string): Promise<void> {
  await client.delete(`/v1/appScreenshots/${screenshotId}`);
}

/** Deletes an entire screenshot set so it can be recreated from scratch. */
export async function deleteScreenshotSet(client: AscClient, setId: string): Promise<void> {
  await client.delete(`/v1/appScreenshotSets/${setId}`);
}