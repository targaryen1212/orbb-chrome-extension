import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticSyncAlarmSchedule,
  enqueuePendingRevocation,
  extractDroppedHttpUrl,
  instagramSavedPageForUsername,
  isSocialPostUrl,
  normalizeSavedUrl,
  platformForUrl,
  pruneExpiredPendingRevocations,
  PROVIDER_PAGES,
  PROVIDER_ORIGINS,
  recoverInterruptedSync,
  removePendingRevocations,
  mergeStoredState,
  socialItemToOrbitItem,
  stateForUi,
  shouldRetryAutomaticSyncOnStartup,
} from "../src/shared";

test("uses the configured interval for both the first and recurring automatic sync", () => {
  const settings = {
    enabled: true,
    frequencyMinutes: 1,
    providers: { instagram: true, reddit: true, x: true },
    maxItemsPerProvider: 0,
  } as const;
  assert.deepEqual(automaticSyncAlarmSchedule(settings), {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
  assert.equal(automaticSyncAlarmSchedule({ ...settings, enabled: false }), null);
});

test("keeps failed revocations queued until success or credential expiry", () => {
  const queued = enqueuePendingRevocation([], {
    accessToken: "token-1",
    expiresAt: 2_000,
  }, 100);
  assert.deepEqual(queued, [{ accessToken: "token-1", expiresAt: 2_000, queuedAt: 100 }]);
  assert.deepEqual(enqueuePendingRevocation(queued, {
    accessToken: "token-1",
    expiresAt: 3_000,
  }, 200), [{ accessToken: "token-1", expiresAt: 3_000, queuedAt: 200 }]);
  assert.deepEqual(removePendingRevocations(queued, ["token-1"]), []);
  assert.deepEqual(pruneExpiredPendingRevocations(queued, 1_999), queued);
  assert.deepEqual(pruneExpiredPendingRevocations(queued, 2_000), []);
});

test("normalizes tracking parameters and fragments", () => {
  assert.equal(
    normalizeSavedUrl("https://example.com/story?utm_source=x&keep=yes#comments"),
    "https://example.com/story?keep=yes",
  );
});

test("canonicalizes Reddit and X aliases for duplicate checks", () => {
  assert.equal(
    normalizeSavedUrl("https://twitter.com/old_name/status/123456789/photo/1?s=20"),
    "https://x.com/i/status/123456789",
  );
  assert.equal(
    normalizeSavedUrl("https://x.com/new_name/status/123456789?ref_src=twsrc%5Etfw"),
    "https://x.com/i/status/123456789",
  );
  assert.equal(
    normalizeSavedUrl("https://old.reddit.com/r/test/comments/abc123/a_title/?utm_source=share"),
    "https://www.reddit.com/comments/abc123/",
  );
  assert.equal(
    normalizeSavedUrl("https://reddit.com/r/test/comments/abc123/a_title/def456/?context=3"),
    "https://www.reddit.com/comments/abc123/_/def456/",
  );
});

test("recognizes supported social post URLs", () => {
  assert.equal(isSocialPostUrl("instagram", "https://www.instagram.com/reel/ABC_123/"), true);
  assert.equal(isSocialPostUrl("reddit", "https://www.reddit.com/r/test/comments/abc123/title/"), true);
  assert.equal(isSocialPostUrl("x", "https://x.com/orbb/status/123456789"), true);
  assert.equal(isSocialPostUrl("x", "https://x.com/home"), false);
});

test("builds the all-posts saved route for any valid Instagram username", () => {
  assert.equal(PROVIDER_PAGES.instagram, "https://www.instagram.com/");
  assert.deepEqual(PROVIDER_ORIGINS.instagram, [
    "https://www.instagram.com/*",
    "https://instagram.com/*",
  ]);
  assert.equal(
    instagramSavedPageForUsername("@example.reader"),
    "https://www.instagram.com/example.reader/saved/all-posts/",
  );
  assert.equal(
    instagramSavedPageForUsername("another_user"),
    "https://www.instagram.com/another_user/saved/all-posts/",
  );
  assert.equal(instagramSavedPageForUsername("not/a/user"), null);
});

test("extracts URLs from browser drag payloads", () => {
  assert.equal(extractDroppedHttpUrl("# first item\nhttps://example.com/story?keep=yes"), "https://example.com/story?keep=yes");
  assert.equal(extractDroppedHttpUrl("Example title\nhttps://example.com/from-title"), "https://example.com/from-title");
  assert.equal(extractDroppedHttpUrl("[Read this](https://example.com/markdown)."), "https://example.com/markdown");
  assert.equal(extractDroppedHttpUrl("text/html:page:https://example.com/download-url"), "https://example.com/download-url");
});

test("migrates legacy sync caps to collect until the feed ends", () => {
  const state = mergeStoredState({
    settings: {
      enabled: false,
      frequencyMinutes: 360,
      providers: { instagram: true, reddit: true, x: true },
      maxItemsPerProvider: 100,
    },
  });
  assert.equal(state.settings.maxItemsPerProvider, 0);
  const stateWithFiveHundred = mergeStoredState({
    settings: {
      enabled: false,
      frequencyMinutes: 360,
      providers: { instagram: true, reddit: true, x: true },
      maxItemsPerProvider: 500,
    },
  });
  assert.equal(stateWithFiveHundred.settings.maxItemsPerProvider, 0);
});

test("preserves the one-minute background sync schedule", () => {
  const state = mergeStoredState({
    settings: {
      enabled: true,
      frequencyMinutes: 1,
      providers: { instagram: true, reddit: true, x: true },
      maxItemsPerProvider: 0,
    },
  });
  assert.equal(state.settings.frequencyMinutes, 1);
});

test("retries only failed automatic syncs when Chrome starts", () => {
  const state = mergeStoredState({
    auth: {
      accessToken: "extension-token",
      expiresAt: Date.now() + 60_000,
      user: { uid: "user-1" },
    },
    settings: {
      enabled: true,
      frequencyMinutes: 30,
      providers: { instagram: true, reddit: true, x: true },
      maxItemsPerProvider: 0,
    },
    sync: { running: false, completed: 0, total: 0, automaticRetryPending: true },
  });
  assert.equal(shouldRetryAutomaticSyncOnStartup(state), true);
  assert.equal(shouldRetryAutomaticSyncOnStartup({
    ...state,
    sync: { ...state.sync, automaticRetryPending: false },
  }), false);
});

test("redacts credentials from state sent to the side panel", () => {
  const state = mergeStoredState({
    auth: {
      accessToken: "secret-extension-token",
      expiresAt: Date.now() + 60_000,
      user: { uid: "user-1", email: "reader@example.com" },
    },
    pendingRevocations: [
      {
        accessToken: "secret-revocation-token",
        expiresAt: Date.now() + 60_000,
        queuedAt: Date.now(),
      },
    ],
  });

  const visible = stateForUi(state);

  assert.equal("pendingRevocations" in visible, false);
  assert.equal("accessToken" in (visible.auth ?? {}), false);
  assert.equal(visible.auth?.user.email, "reader@example.com");
});

test("recovers interrupted sync state when a worker restarts", () => {
  const state = mergeStoredState({
    settings: {
      enabled: true,
      frequencyMinutes: 30,
      providers: { instagram: true, reddit: true, x: true },
      maxItemsPerProvider: 0,
    },
    sync: {
      running: true,
      startedAt: Date.now() - 60_000,
      provider: "instagram",
      completed: 12,
      total: 30,
      automaticRetryPending: true,
    },
  });

  const recovered = recoverInterruptedSync(state);

  assert.equal(recovered.sync.running, false);
  assert.equal(recovered.sync.startedAt, undefined);
  assert.equal(recovered.sync.provider, undefined);
  assert.equal(recovered.sync.automaticRetryPending, true);
  assert.match(recovered.sync.lastError ?? "", /interrupted/);
});

test("maps imported content to private Orbit URL items", () => {
  const item = socialItemToOrbitItem({
    platform: "instagram",
    title: "A saved reel",
    content: "Full captured caption for the saved reel.",
    url: "https://www.instagram.com/reel/ABC/",
    collection: "Recipes",
    importId: "preview-item-1",
  });
  assert.equal(item.source.type, "url");
  assert.equal(item.source.platform, "instagram");
  assert.equal(item.summary, "Full captured caption for the saved reel.");
  assert.equal(item.content?.text, "Full captured caption for the saved reel.");
  assert.deepEqual(item.tags, ["instagram", "imported-save", "Recipes"]);
  assert.equal(item.privacy?.scope, "private");
  assert.equal(item.metadata?.idempotencyKey, "chrome-sync:preview-item-1");
  assert.equal(platformForUrl(item.source.url ?? ""), "instagram");
});
