import type { CreateOrbitItemRequest } from "@orbb/orbit-sdk";
import type {
  AuthState,
  BuiltInSocialProvider,
  PendingRevocationCredential,
  SocialItem,
  SocialProvider,
  StoredState,
  SyncSettings,
  UiStoredState,
} from "./types";

export const DEFAULT_API_BASE_URL = "https://api.orbb.app/v2";
export const SYNC_ALARM = "orbb-social-sync";
export const MAX_DROP_BYTES = 10 * 1024 * 1024;
export const MIN_AUTOMATIC_SYNC_MINUTES = 30;
// A provider's first automatic sync seeds only the newest saves; every later
// run scans newest-first and stops at the first already-synced item.
export const FIRST_SYNC_SEED_COUNT = 3;

export const DEFAULT_SETTINGS: SyncSettings = {
  enabled: false,
  frequencyMinutes: 360,
  // A custom source stays off until someone gives it a page to read.
  providers: { instagram: true, reddit: true, x: true, custom: false },
  // Zero means collect until the provider reports that the saved feed ended.
  maxItemsPerProvider: 0,
};

export const DEFAULT_STATE: StoredState = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  pendingRevocations: [],
  settings: DEFAULT_SETTINGS,
  activity: [],
  capturedUrls: [],
  providerFirstSyncDone: {},
  sync: { running: false, completed: 0, total: 0, automaticRetryPending: false },
};

export function stateForUi(state: StoredState): UiStoredState {
  const { auth, pendingRevocations: _pendingRevocations, ...visibleState } = state;
  return {
    ...visibleState,
    auth: auth
      ? {
          expiresAt: auth.expiresAt,
          user: auth.user,
        }
      : undefined,
  };
}

export interface AutomaticSyncAlarmSchedule {
  delayInMinutes: number;
}

/** How far either side of the chosen frequency a run is allowed to drift. */
export const AUTOMATIC_SYNC_JITTER_RATIO = 0.2;

/**
 * Schedules a single run rather than a fixed period.
 *
 * A clockwork "every 360 minutes exactly" request pattern is the easiest kind
 * of automation for a provider to spot, so each run is scheduled on its own
 * with a fresh offset and the alarm is recreated after it fires.
 */
export function automaticSyncAlarmSchedule(
  settings: SyncSettings,
  random: () => number = Math.random,
): AutomaticSyncAlarmSchedule | null {
  if (!settings.enabled) return null;
  return { delayInMinutes: jitteredSyncDelayMinutes(settings.frequencyMinutes, random) };
}

export function jitteredSyncDelayMinutes(
  frequencyMinutes: number,
  random: () => number = Math.random,
): number {
  const base = normalizeAutomaticSyncFrequency(frequencyMinutes);
  const spread = base * AUTOMATIC_SYNC_JITTER_RATIO;
  const delay = base - spread + random() * spread * 2;
  // Chrome refuses alarms shorter than a minute, and rounding keeps the value
  // off a suspiciously exact boundary.
  return Math.max(1, Math.round(delay * 100) / 100);
}

/**
 * Spreads out a fixed in-page wait so scrolls and saves are not metronomic.
 */
export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  return Math.max(1, Math.round(baseMs * (0.7 + random() * 0.8)));
}

export function normalizeAutomaticSyncFrequency(minutes: number): number {
  const frequencyMinutes = Number.isFinite(minutes)
    ? Math.floor(minutes)
    : DEFAULT_SETTINGS.frequencyMinutes;
  return Math.max(MIN_AUTOMATIC_SYNC_MINUTES, frequencyMinutes);
}

export function enqueuePendingRevocation(
  pending: PendingRevocationCredential[],
  auth: Pick<AuthState, "accessToken" | "expiresAt">,
  queuedAt = Date.now(),
): PendingRevocationCredential[] {
  return [
    ...pending.filter((credential) => credential.accessToken !== auth.accessToken),
    { accessToken: auth.accessToken, expiresAt: auth.expiresAt, queuedAt },
  ];
}

export function removePendingRevocations(
  pending: PendingRevocationCredential[],
  accessTokens: Iterable<string>,
): PendingRevocationCredential[] {
  const removedTokens = new Set(accessTokens);
  return pending.filter((credential) => !removedTokens.has(credential.accessToken));
}

export function pruneExpiredPendingRevocations(
  pending: PendingRevocationCredential[],
  now = Date.now(),
): PendingRevocationCredential[] {
  return pending.filter((credential) => credential.expiresAt > now);
}

export const PROVIDER_PAGES: Record<BuiltInSocialProvider, string> = {
  instagram: "https://www.instagram.com/",
  reddit: "https://www.reddit.com/user/me/saved/",
  x: "https://x.com/i/bookmarks",
};

export const PROVIDER_ORIGINS: Record<BuiltInSocialProvider, string[]> = {
  instagram: [
    "https://www.instagram.com/*",
    "https://instagram.com/*",
  ],
  reddit: [
    "https://www.reddit.com/*",
    "https://reddit.com/*",
  ],
  x: [
    "https://x.com/*",
    "https://twitter.com/*",
  ],
};

/**
 * The page a collection run should open, honouring any configured override.
 *
 * Returns null when a custom source is enabled without a URL — the caller
 * turns that into a message asking for one rather than opening a blank tab.
 */
export function providerStartPage(provider: SocialProvider, settings: SyncSettings): string | null {
  if (provider === "custom") return settings.customUrl ?? null;
  if (provider === "instagram") return settings.instagramUrl ?? PROVIDER_PAGES.instagram;
  return PROVIDER_PAGES[provider];
}

/** Accepts any instagram.com page, so a single saved folder can be targeted. */
export function normalizeInstagramSourceUrl(rawValue: string): string | null {
  const url = parseHttpUrl(rawValue);
  if (!url) return null;
  return url.hostname.replace(/^www\./, "").toLowerCase() === "instagram.com" ? url.toString() : null;
}

export function normalizeCustomSourceUrl(rawValue: string): string | null {
  return parseHttpUrl(rawValue)?.toString() ?? null;
}

function parseHttpUrl(rawValue: string): URL | null {
  try {
    const url = new URL(rawValue.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function providerDisplayName(provider: SocialProvider, settings?: SyncSettings): string {
  if (provider === "custom") return settings?.customName?.trim() || "Custom source";
  if (provider === "x") return "X";
  return provider[0]!.toUpperCase() + provider.slice(1);
}

/**
 * Host permissions a run needs. A custom source is granted per host, so the
 * extension never asks for access to sites it was not pointed at.
 */
export function providerOrigins(provider: SocialProvider, settings: SyncSettings): string[] {
  if (provider !== "custom") return PROVIDER_ORIGINS[provider];
  const customUrl = settings.customUrl ? parseHttpUrl(settings.customUrl) : null;
  return customUrl ? [`${customUrl.origin}/*`] : [];
}

export function instagramSavedPageForUsername(username: string): string | null {
  const normalized = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(normalized)) return null;
  return `https://www.instagram.com/${normalized}/saved/all-posts/`;
}

export function extractDroppedHttpUrl(...values: Array<string | undefined>): string | null {
  for (const rawValue of values) {
    if (!rawValue?.trim()) continue;
    const lines = rawValue.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const match = line.match(/https?:\/\/[^\s<>"']+/i);
      if (!match) continue;
      let candidate = match[0].replace(/[.,;!?]+$/, "");
      while (/[\])}]$/.test(candidate) && hasUnmatchedClosingDelimiter(candidate)) candidate = candidate.slice(0, -1);
      try {
        const url = new URL(candidate);
        if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
      } catch {
        // Keep looking when a drag format contains a malformed URL-like value.
      }
    }
  }
  return null;
}

function hasUnmatchedClosingDelimiter(value: string): boolean {
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  return pairs.some(([open, close]) => value.endsWith(close) && value.split(close).length > value.split(open).length);
}

export function normalizeSavedUrl(rawValue: string): string | null {
  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["igsh", "igshid", "ref", "ref_source", "s"].includes(key)) {
        url.searchParams.delete(key);
      }
    }
    if (["instagram.com", "www.instagram.com", "x.com", "twitter.com", "www.reddit.com", "reddit.com"].includes(url.hostname)) {
      url.search = "";
    }
    const socialCanonicalUrl = canonicalSocialPostUrl(url);
    if (socialCanonicalUrl) return socialCanonicalUrl;
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalSocialPostUrl(url: URL): string | null {
  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  if (hostname === "x.com" || hostname === "twitter.com") {
    const statusId = url.pathname.match(/\/status\/(\d+)/)?.[1];
    return statusId ? `https://x.com/i/status/${statusId}` : null;
  }

  if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) {
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    const postId = commentsIndex >= 0 ? segments[commentsIndex + 1]?.toLowerCase() : undefined;
    if (!postId || !/^[a-z0-9]+$/.test(postId)) return null;
    const commentId = segments[commentsIndex + 3]?.toLowerCase();
    return commentId && /^[a-z0-9]+$/.test(commentId)
      ? `https://www.reddit.com/comments/${postId}/_/${commentId}/`
      : `https://www.reddit.com/comments/${postId}/`;
  }
  return null;
}

export function platformForUrl(rawValue: string): string {
  try {
    const hostname = new URL(rawValue).hostname.replace(/^www\./, "");
    if (hostname.endsWith("instagram.com")) return "instagram";
    if (hostname.endsWith("reddit.com")) return "reddit";
    if (hostname === "x.com" || hostname.endsWith("twitter.com")) return "x";
    return hostname;
  } catch {
    return "web";
  }
}

export function socialItemToOrbitItem(item: SocialItem): CreateOrbitItemRequest {
  // A custom source has no platform of its own, so saved items are labelled
  // with the site the link actually points at.
  const platform = item.platform === "custom" ? platformForUrl(item.url) : item.platform;
  return {
    source: {
      type: "url",
      url: item.url,
      platform,
      capturedAt: new Date().toISOString(),
    },
    title: item.title,
    summary: item.content?.slice(0, 500),
    content: item.content ? { text: item.content } : undefined,
    tags: [platform, "imported-save", ...(item.collection ? [item.collection] : [])],
    metadata: {
      importer: "orbb-chrome-extension",
      collection: item.collection,
      coverImage: item.coverImage,
      idempotencyKey: item.importId ? `chrome-sync:${item.importId}` : undefined,
    },
    privacy: { scope: "private" },
  };
}

export function isSocialPostUrl(provider: SocialProvider, rawValue: string): boolean {
  try {
    const url = new URL(rawValue);
    // A custom source has no post-shaped URL to match, so any web link counts.
    if (provider === "custom") return url.protocol === "http:" || url.protocol === "https:";
    if (provider === "instagram") return /^\/(?:p|reel|reels)\/[A-Za-z0-9_-]+\/?/.test(url.pathname);
    if (provider === "reddit") return /\/comments\/[a-z0-9]+\//i.test(url.pathname);
    return /\/status\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

export function mergeStoredState(value: Partial<StoredState>): StoredState {
  const storedMaxItems = value.settings?.maxItemsPerProvider ?? DEFAULT_SETTINGS.maxItemsPerProvider;
  const storedFrequencyMinutes = value.settings?.frequencyMinutes ?? DEFAULT_SETTINGS.frequencyMinutes;
  return {
    ...DEFAULT_STATE,
    ...value,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    auth: value.auth?.accessToken ? value.auth : undefined,
    pendingRevocations: value.pendingRevocations ?? [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...value.settings,
      frequencyMinutes: normalizeAutomaticSyncFrequency(storedFrequencyMinutes),
      // Earlier builds silently capped providers at 100 and then 500. There is
      // no user-facing limit control, so migrate both values to unlimited.
      maxItemsPerProvider: storedMaxItems === 100 || storedMaxItems === 500
        ? DEFAULT_SETTINGS.maxItemsPerProvider
        : storedMaxItems,
      providers: { ...DEFAULT_SETTINGS.providers, ...value.settings?.providers },
      // Stored URLs are re-validated on read: a value that no longer parses
      // would otherwise send collection to a blank or hostile page.
      instagramUrl: value.settings?.instagramUrl
        ? normalizeInstagramSourceUrl(value.settings.instagramUrl) ?? undefined
        : undefined,
      customUrl: value.settings?.customUrl
        ? normalizeCustomSourceUrl(value.settings.customUrl) ?? undefined
        : undefined,
      customName: value.settings?.customName?.trim() || undefined,
    },
    activity: value.activity ?? [],
    capturedUrls: value.capturedUrls ?? [],
    providerFirstSyncDone: value.providerFirstSyncDone ?? {},
    sync: { ...DEFAULT_STATE.sync, ...value.sync },
  };
}

export function shouldRetryAutomaticSyncOnStartup(state: StoredState): boolean {
  return Boolean(state.settings.enabled && state.auth?.accessToken && state.sync.automaticRetryPending);
}

export function recoverInterruptedSync(state: StoredState): StoredState {
  if (!state.sync.running) return state;
  return {
    ...state,
    sync: {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      lastError: state.settings.enabled
        ? "The previous scheduled collection was interrupted and will be retried."
        : "The previous collection was interrupted. You can start it again.",
      automaticRetryPending: state.settings.enabled,
    },
  };
}
