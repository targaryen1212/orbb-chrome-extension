import type { CreateOrbitItemRequest, OrbitQrAuthSession } from "@orbb/orbit-sdk";

export type SocialProvider = "instagram" | "reddit" | "x";

export interface AuthState {
  accessToken: string;
  expiresAt: number;
  user: {
    uid: string;
    email?: string;
    displayName?: string;
    photoURL?: string;
  };
}

export interface PendingRevocationCredential {
  accessToken: string;
  expiresAt: number;
  queuedAt: number;
}

export interface SyncSettings {
  enabled: boolean;
  frequencyMinutes: number;
  providers: Record<SocialProvider, boolean>;
  maxItemsPerProvider: number;
}

export interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  platform: string;
  status: "saved" | "skipped" | "failed" | "syncing";
  createdAt: number;
}

export interface SyncState {
  running: boolean;
  startedAt?: number;
  provider?: SocialProvider;
  completed: number;
  total: number;
  lastRunAt?: number;
  lastError?: string;
  automaticRetryPending?: boolean;
}

export interface StoredState {
  apiBaseUrl: string;
  auth?: AuthState;
  pendingRevocations: PendingRevocationCredential[];
  qrSession?: OrbitQrAuthSession;
  settings: SyncSettings;
  activity: ActivityItem[];
  capturedUrls: string[];
  /** Providers whose seeding first sync completed; later runs stop at known items. */
  providerFirstSyncDone: Partial<Record<SocialProvider, boolean>>;
  sync: SyncState;
}

export type UiAuthState = Omit<AuthState, "accessToken">;

export type UiStoredState = Omit<StoredState, "auth" | "pendingRevocations"> & {
  auth?: UiAuthState;
};

export type SyncSettingsPatch = Omit<Partial<SyncSettings>, "providers"> & {
  providers?: Partial<SyncSettings["providers"]>;
};

export interface SocialItem {
  platform: SocialProvider;
  url: string;
  title: string;
  content?: string;
  collection?: string;
  coverImage?: string;
  importId?: string;
  alreadySaved?: boolean;
}

export type BackgroundRequest =
  | { type: "GET_SNAPSHOT" }
  | { type: "BEGIN_QR_AUTH" }
  | { type: "POLL_QR_AUTH" }
  | { type: "CANCEL_QR_AUTH" }
  | { type: "SIGN_OUT" }
  | { type: "CLEAR_ACTIVITY" }
  | { type: "SAVE_CURRENT_PAGE"; note?: string }
  | { type: "SAVE_ITEM"; item: CreateOrbitItemRequest; dedupeUrl?: string }
  | { type: "PREVIEW_SYNC"; provider: SocialProvider; limit?: number }
  | { type: "CANCEL_SYNC" }
  | { type: "SAVE_SYNC_PREVIEW"; provider: SocialProvider; items: SocialItem[] }
  | { type: "UPDATE_SETTINGS"; settings: SyncSettingsPatch };

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
