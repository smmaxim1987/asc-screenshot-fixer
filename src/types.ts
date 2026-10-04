/**
 * App Store Connect key type.
 *
 * - `team` — Team Key: access to every app in the team; the role is assigned to the key.
 * - `individual` — Individual Key: access and roles of the associated user.
 *
 * The difference matters for the JWT: an individual key's payload requires the
 * `sub: "user"` claim — without it Apple rejects the token with 401.
 */
export type KeyKind = 'team' | 'individual';

export interface Credentials {
  issuerId: string;
  keyId: string;
  /** Private key in PEM format (the contents of an AuthKey_XXXX.p8 file). */
  privateKey: string;
  /** Key type. Defaults to team — a Team Key payload does not require `sub`. */
  keyKind?: KeyKind;
  /** Optional: open this app right away. */
  bundleId?: string;
}

export interface AppRef {
  id: string;
  bundleId: string;
  name: string;
  sku: string | null;
}

/** assetDeliveryState from the App Store Connect API. */
export type AssetDeliveryState =
  | 'AWAITING_UPLOAD'
  | 'UPLOAD_COMPLETE'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'FAILED'
  | 'EXPIRED'
  | 'MISSING_UPLOAD'
  | (string & {});

export type ScreenshotVerdict =
  /** Processed successfully and available in the store. */
  | 'ok'
  /** Stuck in a terminal or broken state — the web UI refuses to delete it. */
  | 'stuck'
  /** Uploaded but still processing — usually clears itself within minutes. */
  | 'processing';

export interface Screenshot {
  id: string;
  fileName: string | null;
  fileSize: number | null;
  assetDeliveryState: AssetDeliveryState;
  verdict: ScreenshotVerdict;
  sourceFileChecksum: string | null;
  imageAsset: { templateUrl: string; width: number; height: number } | null;
  /** Preview URL, present only once the asset has been processed. */
  imageUrl: string | null;
  uploadedAt: string | null;
  errorMessage: string | null;
}

export interface ScreenshotSet {
  id: string;
  /** Display type, e.g. APP_IPHONE_65. */
  screenshotDisplayType: string;
  localizationId: string | null;
  locale: string | null;
  platform: string | null;
  screenshots: Screenshot[];
}

export interface AppScanResult {
  app: AppRef;
  sets: ScreenshotSet[];
  totals: {
    sets: number;
    screenshots: number;
    stuck: number;
    processing: number;
    ok: number;
  };
}