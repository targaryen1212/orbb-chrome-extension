import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticSyncAlarmSchedule,
  enqueuePendingRevocation,
  extractDroppedHttpUrl,
  instagramSavedPageForUsername,
  isSocialPostUrl,
  jitteredDelayMs,
  jitteredSyncDelayMinutes,
  dueSource,
  INSTAGRAM_AUTO_SOURCE,
  instagramSourceKeys,
  nextSourceDelayMs,
  normalizeCustomSourceUrl,
  normalizeInstagramSourceUrl,
  normalizeInstagramSourceUrls,
  pruneSourceSchedule,
  normalizeSavedUrl,
  providerDisplayName,
  providerOrigins,
  providerStartPage,
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
    frequencyMinutes: 30,
    providers: { instagram: true, reddit: true, x: true, custom: false },
    maxItemsPerProvider: 0,
  } as const;
  assert.deepEqual(automaticSyncAlarmSchedule(settings, () => 0), { delayInMinutes: 24 });
  assert.deepEqual(automaticSyncAlarmSchedule(settings, () => 0.5), { delayInMinutes: 30 });
  assert.deepEqual(automaticSyncAlarmSchedule(settings, () => 1), { delayInMinutes: 36 });
  assert.equal(automaticSyncAlarmSchedule({ ...settings, enabled: false }), null);

  // Two consecutive runs must not land on the same minute.
  const random = (() => {
    const values = [0.13, 0.86];
    let index = 0;
    return () => values[index++ % values.length]!;
  })();
  assert.notEqual(
    automaticSyncAlarmSchedule(settings, random)?.delayInMinutes,
    automaticSyncAlarmSchedule(settings, random)?.delayInMinutes,
  );
});

test("keeps jittered waits positive and bounded", () => {
  assert.equal(jitteredSyncDelayMinutes(30, () => 0), 24);
  assert.equal(jitteredSyncDelayMinutes(30, () => 1), 36);
  // Frequencies below the supported minimum are raised before jitter applies.
  assert.equal(jitteredSyncDelayMinutes(1, () => 0.5), 30);
  assert.equal(jitteredDelayMs(250, () => 0), 175);
  assert.equal(jitteredDelayMs(250, () => 1), 375);
  assert.ok(jitteredDelayMs(0, () => 0) >= 1);
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
      providers: { instagram: true, reddit: true, x: true, custom: false },
      maxItemsPerProvider: 100,
    },
  });
  assert.equal(state.settings.maxItemsPerProvider, 0);
  const stateWithFiveHundred = mergeStoredState({
    settings: {
      enabled: false,
      frequencyMinutes: 360,
      providers: { instagram: true, reddit: true, x: true, custom: false },
      maxItemsPerProvider: 500,
    },
  });
  assert.equal(stateWithFiveHundred.settings.maxItemsPerProvider, 0);
});

test("migrates the removed one-minute schedule to every 30 minutes", () => {
  const state = mergeStoredState({
    settings: {
      enabled: true,
      frequencyMinutes: 1,
      providers: { instagram: true, reddit: true, x: true, custom: false },
      maxItemsPerProvider: 0,
    },
  });
  assert.equal(state.settings.frequencyMinutes, 30);
  assert.deepEqual(automaticSyncAlarmSchedule(state.settings, () => 0.5), {
    delayInMinutes: 30,
  });
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
      providers: { instagram: true, reddit: true, x: true, custom: false },
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
      providers: { instagram: true, reddit: true, x: true, custom: false },
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

test("routes collection to the configured source pages", () => {
  const base = mergeStoredState({}).settings;
  assert.equal(providerStartPage("instagram", base), PROVIDER_PAGES.instagram);
  assert.equal(providerStartPage("reddit", base), PROVIDER_PAGES.reddit);
  // A custom source with no address must not open a blank tab.
  assert.equal(providerStartPage("custom", base), null);

  const configured = {
    ...base,
    instagramUrls: ["https://www.instagram.com/me/saved/food/"],
    customUrl: "https://example.com/links",
  };
  assert.equal(providerStartPage("instagram", configured), "https://www.instagram.com/me/saved/food/");
  assert.equal(providerStartPage("custom", configured), "https://example.com/links");
});

test("accepts only usable source addresses", () => {
  assert.equal(
    normalizeInstagramSourceUrl(" https://instagram.com/me/saved/food/ "),
    "https://instagram.com/me/saved/food/",
  );
  assert.equal(normalizeInstagramSourceUrl("https://example.com/me/saved/"), null);
  assert.equal(normalizeInstagramSourceUrl("instagram.com/me"), null);
  assert.equal(normalizeCustomSourceUrl("https://example.com/links"), "https://example.com/links");
  assert.equal(normalizeCustomSourceUrl("javascript:alert(1)"), null);
  assert.equal(normalizeCustomSourceUrl("not a url"), null);
});

test("discards stored source addresses that no longer parse", () => {
  const state = mergeStoredState({
    settings: {
      ...mergeStoredState({}).settings,
      instagramUrls: ["https://evil.example.com/saved/", "https://www.instagram.com/me/saved/a/"],
      customUrl: "javascript:alert(1)",
      customName: "  Reading list  ",
    },
  });
  // The instagram.com entry survives; the impostor is dropped.
  assert.deepEqual(state.settings.instagramUrls, ["https://www.instagram.com/me/saved/a/"]);
  assert.equal(state.settings.customUrl, undefined);
  assert.equal(state.settings.customName, "Reading list");
});

test("migrates a single stored Instagram page to the multi-page list", () => {
  const state = mergeStoredState({
    settings: {
      ...mergeStoredState({}).settings,
      instagramUrl: "https://www.instagram.com/me/saved/food/",
    } as never,
  });
  assert.deepEqual(state.settings.instagramUrls, ["https://www.instagram.com/me/saved/food/"]);
});

test("validates and de-duplicates a list of Instagram pages", () => {
  assert.deepEqual(
    normalizeInstagramSourceUrls([
      " https://www.instagram.com/me/saved/a/ ",
      "",
      "https://www.instagram.com/me/saved/a/",
      "https://www.instagram.com/me/saved/b/",
    ]),
    ["https://www.instagram.com/me/saved/a/", "https://www.instagram.com/me/saved/b/"],
  );
  assert.throws(() => normalizeInstagramSourceUrls(["https://example.com/x"]), /not an instagram\.com address/);
});

test("collects one Instagram page per run and defers the rest by hours", () => {
  const settings = {
    ...mergeStoredState({}).settings,
    instagramUrls: ["https://www.instagram.com/me/saved/a/", "https://www.instagram.com/me/saved/b/"],
  };
  const keys = instagramSourceKeys(settings);
  assert.deepEqual(keys, settings.instagramUrls);
  assert.deepEqual(instagramSourceKeys(mergeStoredState({}).settings), [INSTAGRAM_AUTO_SOURCE]);

  const now = 10_000_000;
  // Nothing collected yet: the first configured page goes first.
  assert.equal(dueSource(keys, {}, now), keys[0]);
  // Once it is deferred, the run picks the other page rather than repeating.
  const afterFirst = { [keys[0]!]: now + 3_600_000 };
  assert.equal(dueSource(keys, afterFirst, now), keys[1]);
  // With both deferred, no Instagram page runs at all this time.
  assert.equal(dueSource(keys, { ...afterFirst, [keys[1]!]: now + 60_000 }, now), null);
  // A page whose wait has elapsed becomes eligible again.
  assert.equal(dueSource(keys, { [keys[0]!]: now - 1, [keys[1]!]: now + 60_000 }, now), keys[0]);

  // Deferrals land between one and six hours out, and vary between sources.
  assert.equal(nextSourceDelayMs(() => 0), 3_600_000);
  assert.equal(nextSourceDelayMs(() => 1), 21_600_000);
  assert.notEqual(nextSourceDelayMs(() => 0.2), nextSourceDelayMs(() => 0.8));

  assert.deepEqual(
    pruneSourceSchedule({ [keys[0]!]: 1, "https://www.instagram.com/me/saved/gone/": 2 }, keys),
    { [keys[0]!]: 1 },
  );
});

test("labels and matches items from a custom source", () => {
  assert.equal(providerDisplayName("custom", undefined), "Custom source");
  assert.equal(
    providerDisplayName("custom", { ...mergeStoredState({}).settings, customName: "Reading list" }),
    "Reading list",
  );
  assert.equal(isSocialPostUrl("custom", "https://example.com/any/article"), true);
  assert.equal(isSocialPostUrl("custom", "mailto:someone@example.com"), false);

  // Custom items are tagged with the site they came from, not "custom".
  const item = socialItemToOrbitItem({
    platform: "custom",
    title: "An article",
    url: "https://example.com/any/article",
  });
  assert.equal(item.source.platform, "example.com");
  assert.deepEqual(item.tags, ["example.com", "imported-save"]);
});

test("defaults and preserves the per-provider first-sync markers", () => {
  assert.deepEqual(mergeStoredState({}).providerFirstSyncDone, {});
  const state = mergeStoredState({ providerFirstSyncDone: { instagram: true } });
  assert.deepEqual(state.providerFirstSyncDone, { instagram: true });
});
