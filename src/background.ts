import { OrbitClient } from "@orbb/orbit-sdk";
import type { CreateOrbitItemRequest } from "@orbb/orbit-sdk";
import {
  DEFAULT_SETTINGS,
  FIRST_SYNC_SEED_COUNT,
  automaticSyncAlarmSchedule,
  enqueuePendingRevocation,
  instagramSavedPageForUsername,
  isSocialPostUrl,
  jitteredDelayMs,
  normalizeCustomSourceUrl,
  normalizeInstagramSourceUrl,
  providerDisplayName,
  providerOrigins,
  providerStartPage,
  PROVIDER_PAGES,
  SYNC_ALARM,
  mergeStoredState,
  normalizeAutomaticSyncFrequency,
  normalizeSavedUrl,
  platformForUrl,
  pruneExpiredPendingRevocations,
  recoverInterruptedSync,
  removePendingRevocations,
  socialItemToOrbitItem,
  stateForUi,
  shouldRetryAutomaticSyncOnStartup,
} from "./shared";
import type {
  ActivityItem,
  AuthState,
  BackgroundRequest,
  BackgroundResponse,
  SocialItem,
  SocialProvider,
  StoredState,
  SyncSettings,
  SyncSettingsPatch,
  UiStoredState,
} from "./types";

const STATE_KEY = "orbbState";
const MAX_ACTIVITY = 40;
const MAX_CAPTURED_URLS = 5000;
const REVOCATION_TIMEOUT_MS = 3_000;
const COLLECTION_BUDGET_MS = 4 * 60_000;
let activeSyncTabId: number | undefined;
let syncCancellationRequested = false;
let pendingRevocationRetry: Promise<void> | undefined;
let qrPollRequest: Promise<{ status: string; user?: AuthState["user"] }> | undefined;

void chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => undefined);
const startupRecovery = recoverInterruptedSyncOnWorkerStart().catch(
  () => undefined,
);
void retryPendingRevocations().catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void handleBrowserStartup();
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void startupRecovery.then(() => runScheduledSync());
  }
});

/**
 * Runs a scheduled sync, then books the next one at a fresh random offset.
 *
 * The alarm is one-shot by design, so rescheduling has to happen even when the
 * run throws — otherwise a single failure would end automatic collection.
 */
async function runScheduledSync(): Promise<void> {
  try {
    await runAutomaticSync();
  } catch {
    // runAutomaticSync already records the failure in state and activity.
  } finally {
    await restoreAlarm();
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenu(info, tab);
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest | { type: "ORBB_STATE_UPDATED" }, _sender, sendResponse) => {
  if (request.type === "ORBB_STATE_UPDATED") return false;
  void handleRequest(request)
    .then((data) => sendResponse({ ok: true, data } satisfies BackgroundResponse))
    .catch((error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies BackgroundResponse));
  return true;
});

async function initializeExtension(): Promise<void> {
  await retryPendingRevocations().catch(() => undefined);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "save-to-orbb",
    title: "Save to Orbb",
    contexts: ["page", "link", "image", "selection"],
  });
  const state = recoverInterruptedSync(await getState());
  await setState(state);
  await restoreAlarm();
}

async function handleBrowserStartup(): Promise<void> {
  await retryPendingRevocations().catch(() => undefined);
  let state = recoverInterruptedSync(await getState());
  await setState(state);
  await restoreAlarm();
  state = await getState();
  if (!shouldRetryAutomaticSyncOnStartup(state)) return;
  try {
    await addActivity({
      title: "Retrying automatic sync",
      detail: "Chrome reopened after the previous scheduled run failed or was interrupted",
      platform: "chrome",
      status: "syncing",
    });
    await runAutomaticSync();
  } catch (error) {
    state = await getState();
    state.sync = {
      ...state.sync,
      running: false,
      provider: undefined,
      automaticRetryPending: true,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await setState(state);
  }
}

async function handleRequest(request: BackgroundRequest): Promise<unknown> {
  await startupRecovery;
  switch (request.type) {
    case "GET_SNAPSHOT":
      return getSnapshot();
    case "BEGIN_QR_AUTH":
      return beginQrAuth();
    case "POLL_QR_AUTH":
      return pollQrAuth();
    case "CANCEL_QR_AUTH":
      return cancelQrAuth();
    case "SIGN_OUT":
      return signOut();
    case "CLEAR_ACTIVITY":
      return clearActivity();
    case "SAVE_CURRENT_PAGE":
      return saveCurrentPage(request.note);
    case "SAVE_ITEM":
      return saveItem(request.item, { dedupeUrl: request.dedupeUrl, recordActivity: true });
    case "PREVIEW_SYNC":
      return previewSocialSync(request.provider, request.limit);
    case "CANCEL_SYNC":
      return cancelSync();
    case "SAVE_SYNC_PREVIEW":
      return saveSyncPreview(request.provider, request.items);
    case "UPDATE_SETTINGS":
      return updateSettings(request.settings);
  }
}

async function getSnapshot(): Promise<{ state: UiStoredState; currentTab: { title: string; url: string } | null }> {
  const [state, tabs] = await Promise.all([
    getState(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const tab = tabs[0];
  const url = tab?.url && /^https?:/.test(tab.url) ? tab.url : "";
  return {
    state: stateForUi(state),
    currentTab: url ? { title: tab?.title || new URL(url).hostname, url } : null,
  };
}

async function beginQrAuth() {
  const state = await getState();
  const client = createOrbitClient(state.apiBaseUrl);
  const session = await client.auth.qr.create({
    client: {
      type: "chrome_extension",
      name: "Orbb for Chrome",
      extensionId: chrome.runtime.id,
      platform: navigator.userAgent,
    },
    scopes: ["items:write"],
  });
  state.qrSession = session;
  await setState(state);
  return session;
}

function pollQrAuth(): Promise<{ status: string; user?: AuthState["user"] }> {
  if (qrPollRequest) return qrPollRequest;
  qrPollRequest = pollQrAuthOnce().finally(() => {
    qrPollRequest = undefined;
  });
  return qrPollRequest;
}

async function pollQrAuthOnce(): Promise<{ status: string; user?: AuthState["user"] }> {
  const state = await getState();
  const session = state.qrSession;
  if (!session) throw new Error("Start QR login first.");

  const client = createOrbitClient(state.apiBaseUrl);
  const result = await client.auth.qr.poll(session);
  const latest = await getState();
  const currentSession = latest.qrSession;
  const isCurrentSession =
    currentSession?.sessionId === session.sessionId &&
    currentSession.code === session.code;
  if (!isCurrentSession) {
    return { status: latest.auth ? "authorized" : "cancelled" };
  }

  if (result.status === "authorized") {
    const accessToken = result.token?.accessToken;
    const expiresAt = result.token?.expiresAt;
    if (!accessToken || !expiresAt || !result.user?.uid) {
      throw new Error("Orbb V2 authorized the session without a valid access token.");
    }
    const expiresAtMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("Orbb V2 returned an invalid or expired access token.");
    }
    latest.auth = {
      accessToken,
      expiresAt: expiresAtMs,
      user: {
        uid: result.user.uid,
        email: result.user.email,
        displayName: result.user.displayName,
        photoURL: result.user.photoURL,
      },
    };
    delete latest.qrSession;
    await setState(latest);
    await addActivity({
      title: "Chrome connected",
      detail: latest.auth.user.email || latest.auth.user.displayName || "Orbb account",
      platform: "orbb",
      status: "saved",
    });
    return { status: "authorized", user: latest.auth.user };
  }

  if (["expired", "cancelled", "consumed"].includes(result.status)) {
    delete latest.qrSession;
    await setState(latest);
  }
  return { status: result.status };
}

async function cancelQrAuth(): Promise<void> {
  const state = await getState();
  if (state.qrSession) {
    const client = createOrbitClient(state.apiBaseUrl);
    await client.auth.qr.cancel(state.qrSession).catch(() => undefined);
    delete state.qrSession;
    await setState(state);
  }
}

function createOrbitClient(baseUrl: string, accessToken?: string, requestTimeoutMs?: number): OrbitClient {
  return new OrbitClient({
    baseUrl,
    apiPath: false,
    apiKey: accessToken,
    requestTimeoutMs,
    client: { version: chrome.runtime.getManifest().version, platform: "chrome" },
    // Chrome's native fetch requires WorkerGlobalScope as its receiver. The
    // Orbit SDK stores fetch as a class property, so use an arrow wrapper that
    // cannot be rebound when the SDK invokes it.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

async function signOut(): Promise<void> {
  const initialState = await getState();
  const auth = initialState.auth;
  let revoked = false;

  if (auth) {
    try {
      await revokeCredential(initialState.apiBaseUrl, auth.accessToken);
      revoked = true;
    } catch {
      // Keep the credential only as a revocation marker. The signed-out UI is
      // still applied below, and Chrome retries the server revoke on startup.
    }
  }

  const state = await getState();
  delete state.auth;
  delete state.qrSession;
  if (auth) {
    state.pendingRevocations = revoked
      ? removePendingRevocations(state.pendingRevocations, [auth.accessToken])
      : enqueuePendingRevocation(state.pendingRevocations, auth);
  }
  state.sync = { running: false, completed: 0, total: 0, lastRunAt: state.sync.lastRunAt };
  await setState(state);
}

async function revokeCredential(baseUrl: string, accessToken: string): Promise<unknown> {
  try {
    return await createOrbitClient(baseUrl, accessToken, REVOCATION_TIMEOUT_MS)
      .auth.revokeCurrentSession();
  } catch (error) {
    if (isAuthorizationRejection(error)) return undefined;
    throw error;
  }
}

function retryPendingRevocations(): Promise<void> {
  if (pendingRevocationRetry) return pendingRevocationRetry;
  pendingRevocationRetry = retryPendingRevocationsImpl()
    .finally(() => { pendingRevocationRetry = undefined; });
  return pendingRevocationRetry;
}

async function retryPendingRevocationsImpl(): Promise<void> {
  const state = await getState();
  const active = pruneExpiredPendingRevocations(state.pendingRevocations);
  const revokedTokens = new Set<string>();
  await Promise.all(active.map(async (credential) => {
    try {
      await revokeCredential(state.apiBaseUrl, credential.accessToken);
      revokedTokens.add(credential.accessToken);
    } catch {
      // Offline and transient failures remain queued for the next startup.
    }
  }));

  const latest = await getState();
  const remaining = removePendingRevocations(
    pruneExpiredPendingRevocations(latest.pendingRevocations),
    revokedTokens,
  );
  if (remaining.length !== latest.pendingRevocations.length) {
    latest.pendingRevocations = remaining;
    await setState(latest);
  }
}

async function clearActivity(): Promise<void> {
  const state = await getState();
  state.activity = [];
  await setState(state);
}

async function recoverInterruptedSyncOnWorkerStart(): Promise<void> {
  const state = await getState();
  const recovered = recoverInterruptedSync(state);
  if (recovered !== state) await setState(recovered);
}

async function requireFreshAuth(state: StoredState): Promise<AuthState> {
  if (!state.auth) throw new Error("Connect Orbb before saving.");
  if (!Number.isFinite(state.auth.expiresAt) || state.auth.expiresAt <= Date.now()) {
    delete state.auth;
    await setState(state);
    throw new Error("Your Orbb V2 session expired. Scan a new login code.");
  }
  return state.auth;
}

async function saveCurrentPage(note?: string): Promise<unknown> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("This Chrome page cannot be saved.");
  const normalized = normalizeSavedUrl(tab.url) || tab.url;
  return saveItem({
    source: {
      type: "url",
      url: normalized,
      platform: platformForUrl(normalized),
      capturedAt: new Date().toISOString(),
    },
    title: tab.title || new URL(normalized).hostname,
    note,
    tags: ["chrome"],
    metadata: { importer: "orbb-chrome-extension", capture: "current-page" },
    privacy: { scope: "private" },
  }, { dedupeUrl: normalized, recordActivity: true });
}

async function saveItem(
  item: CreateOrbitItemRequest,
  options: { dedupeUrl?: string; recordActivity: boolean; knownNew?: boolean },
): Promise<{ saved: boolean; duplicate?: boolean }> {
  const state = await getState();
  const auth = await requireFreshAuth(state);
  const dedupeUrl = options.dedupeUrl ? normalizeSavedUrl(options.dedupeUrl) : undefined;
  const client = createOrbitClient(state.apiBaseUrl, auth.accessToken);
  const locallySaved = Boolean(dedupeUrl && state.capturedUrls.includes(dedupeUrl));
  const remotelySaved = dedupeUrl && !locallySaved && !options.knownNew
    ? (await client.bookmarks.findExistingUrls([dedupeUrl])).has(dedupeUrl)
    : false;
  if (dedupeUrl && (locallySaved || remotelySaved)) {
    if (remotelySaved) {
      state.capturedUrls = [dedupeUrl, ...state.capturedUrls].slice(0, MAX_CAPTURED_URLS);
      await setState(state);
    }
    if (options.recordActivity) {
      await addActivity({
        title: item.title || "Already in Orbb",
        detail: "Skipped a duplicate link",
        platform: item.source.platform || platformForUrl(dedupeUrl),
        status: "skipped",
      });
    }
    return { saved: false, duplicate: true };
  }

  try {
    await client.bookmarks.createItem(item);
  } catch (error) {
    if (isAuthorizationRejection(error)) {
      await clearRejectedAuth(auth.accessToken);
    }
    if (options.recordActivity) {
      await addActivity({
        title: item.title || "Save failed",
        detail: error instanceof Error ? error.message : "Orbit could not save this item",
        platform: item.source.platform || item.source.type,
        status: "failed",
      });
    }
    throw error;
  }

  if (dedupeUrl) {
    const latest = await getState();
    latest.capturedUrls = [dedupeUrl, ...latest.capturedUrls.filter((url) => url !== dedupeUrl)].slice(0, MAX_CAPTURED_URLS);
    await setState(latest);
  }
  if (options.recordActivity) {
    await addActivity({
      title: item.title || defaultItemTitle(item),
      detail: "Saved to Orbb",
      platform: item.source.platform || item.source.type,
      status: "saved",
    });
  }
  return { saved: true };
}

function defaultItemTitle(item: CreateOrbitItemRequest): string {
  if (item.source.type === "image") return "Saved image";
  if (item.source.type === "audio") return "Saved audio";
  if (item.source.type === "file") return "Saved file";
  return "Saved link";
}

async function handleContextMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  try {
    if (info.selectionText) {
      await saveItem({
        source: { type: "quote", text: info.selectionText, url: info.pageUrl, platform: platformForUrl(info.pageUrl || "") },
        title: tab?.title ? `Quote from ${tab.title}` : "Saved quote",
        content: { text: info.selectionText },
        metadata: { sourcePageUrl: info.pageUrl, importer: "orbb-chrome-extension" },
        privacy: { scope: "private" },
      }, { recordActivity: true });
      return;
    }
    if (info.srcUrl) {
      await saveItem({
        source: { type: "image", url: info.srcUrl, platform: platformForUrl(info.pageUrl || info.srcUrl) },
        title: tab?.title ? `Image from ${tab.title}` : "Saved image",
        metadata: { sourcePageUrl: info.pageUrl, importer: "orbb-chrome-extension" },
        privacy: { scope: "private" },
      }, { dedupeUrl: info.srcUrl, recordActivity: true });
      return;
    }
    const url = info.linkUrl || info.pageUrl || tab?.url;
    if (!url) throw new Error("No link was available to save.");
    const normalized = normalizeSavedUrl(url) || url;
    await saveItem({
      source: { type: "url", url: normalized, platform: platformForUrl(normalized) },
      title: tab?.title || new URL(normalized).hostname,
      metadata: { importer: "orbb-chrome-extension", capture: info.linkUrl ? "context-link" : "context-page" },
      privacy: { scope: "private" },
    }, { dedupeUrl: normalized, recordActivity: true });
  } catch (error) {
    await addActivity({
      title: "Save failed",
      detail: error instanceof Error ? error.message : String(error),
      platform: "chrome",
      status: "failed",
    });
  }
}

async function updateSettings(patch: SyncSettingsPatch): Promise<SyncSettings> {
  const state = await getState();
  const settings: SyncSettings = {
    ...state.settings,
    ...patch,
    providers: { ...state.settings.providers, ...patch.providers },
    frequencyMinutes: normalizeAutomaticSyncFrequency(
      patch.frequencyMinutes ?? state.settings.frequencyMinutes,
    ),
    maxItemsPerProvider: normalizeSyncLimit(patch.maxItemsPerProvider ?? state.settings.maxItemsPerProvider),
  };

  if (patch.instagramUrl !== undefined) {
    settings.instagramUrl = patch.instagramUrl.trim()
      ? normalizeInstagramSourceUrl(patch.instagramUrl) ?? throwSettingError(
          "Enter an instagram.com address, like https://www.instagram.com/<account>/saved/<folder>/.",
        )
      : undefined;
  }
  if (patch.customUrl !== undefined) {
    settings.customUrl = patch.customUrl.trim()
      ? normalizeCustomSourceUrl(patch.customUrl) ?? throwSettingError(
          "Enter a full web address for the custom source, including https://.",
        )
      : undefined;
  }
  if (patch.customName !== undefined) {
    settings.customName = patch.customName.trim().slice(0, 60) || undefined;
  }
  // A source with nowhere to look would fail on every scheduled run.
  if (settings.providers.custom && !settings.customUrl) {
    throwSettingError("Add a page address before turning on the custom source.");
  }

  state.settings = settings;
  await setState(state);
  await restoreAlarm();
  return state.settings;
}

function throwSettingError(message: string): never {
  throw new Error(message);
}

async function restoreAlarm(): Promise<void> {
  const state = await getState();
  await chrome.alarms.clear(SYNC_ALARM);
  const schedule = automaticSyncAlarmSchedule(state.settings);
  if (schedule) await chrome.alarms.create(SYNC_ALARM, schedule);
}

async function previewSocialSync(provider: SocialProvider, limit?: number): Promise<SocialItem[]> {
  let state = await getState();
  await requireFreshAuth(state);
  if (state.sync.running) throw new Error("Another sync is already running.");
  syncCancellationRequested = false;
  state.sync = {
    ...state.sync,
    running: true,
    startedAt: Date.now(),
    provider,
    completed: 0,
    total: 0,
  };
  await setState(state);
  try {
    // The panel's "import the latest N" choice; zero or absent collects the
    // whole feed, matching the maxItemsPerProvider convention.
    const items = await collectProvider(provider, state.settings, limit ?? state.settings.maxItemsPerProvider);
    const markedItems = await markAlreadySaved(items);
    state = await getState();
    state.sync = {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      completed: 0,
      total: items.length,
    };
    await setState(state);
    return markedItems;
  } catch (error) {
    state = await getState();
    state.sync = {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      lastError: syncCancellationRequested ? undefined : error instanceof Error ? error.message : String(error),
    };
    await setState(state);
    throw error;
  }
}

async function cancelSync(): Promise<void> {
  syncCancellationRequested = true;
  const tabId = activeSyncTabId;
  activeSyncTabId = undefined;
  if (tabId != null) await chrome.tabs.remove(tabId).catch(() => undefined);
  const state = await getState();
  state.sync = {
    ...state.sync,
    running: false,
    startedAt: undefined,
    provider: undefined,
    lastError: undefined,
  };
  await setState(state);
}

async function saveSyncPreview(
  provider: SocialProvider,
  inputItems: SocialItem[],
): Promise<{ total: number; saved: number; skipped: number; failed: number }> {
  let state = await getState();
  await requireFreshAuth(state);
  if (state.sync.running) throw new Error("Another sync is already running.");

  const items = deduplicateSocialItems(inputItems
    .filter((item) => item.platform === provider && isSocialPostUrl(provider, item.url)));
  if (items.length === 0) throw new Error("Select at least one captured item to save.");

  state.sync = {
    ...state.sync,
    running: true,
    startedAt: Date.now(),
    provider,
    completed: 0,
    total: items.length,
  };
  await setState(state);
  let existingUrls: Set<string>;
  try {
    existingUrls = await existingSourceUrls(items.map((item) => item.url));
  } catch (error) {
    state = await getState();
    state.sync = {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await setState(state);
    throw error;
  }
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  const completedUrls: string[] = [];
  for (const item of items) {
    const normalized = normalizeSavedUrl(item.url);
    if (!normalized) {
      failed += 1;
    } else {
      if (existingUrls.has(normalized) || item.alreadySaved) {
        skipped += 1;
        completedUrls.push(normalized);
      } else {
        try {
          await saveItem(socialItemToOrbitItem({ ...item, url: normalized }), {
            dedupeUrl: normalized,
            recordActivity: false,
            knownNew: true,
          });
          saved += 1;
          completedUrls.push(normalized);
        } catch {
          failed += 1;
        }
      }
    }
    state = await getState();
    state.sync.completed = saved + skipped + failed;
    await setState(state);
    await delay(jitteredDelayMs(150));
  }

  const result = { total: items.length, saved, skipped, failed };
  // A manual import is as good a baseline as an automatic seed: only the
  // successfully handled URLs become stop markers, so failed items are
  // re-collected next time instead of being skipped over.
  await markProviderSynced(provider, completedUrls);
  await addActivity({
    title: `${providerLabel(provider, state.settings)} manual import ${failed ? "finished with errors" : "complete"}`,
    detail: `${saved} saved${skipped ? `, ${skipped} already in Orbb` : ""}${failed ? `, ${failed} failed` : ""}`,
    platform: provider,
    status: failed ? "failed" : "saved",
  });
  state = await getState();
  state.sync = {
    ...state.sync,
    running: false,
    startedAt: undefined,
    provider: undefined,
    lastRunAt: Date.now(),
    lastError: failed ? `${failed} item${failed === 1 ? "" : "s"} failed to save.` : undefined,
  };
  await setState(state);
  return result;
}

async function runAutomaticSync(): Promise<StoredState["sync"]> {
  let state = await getState();
  if (state.sync.running) return state.sync;
  syncCancellationRequested = false;

  const providers = (Object.keys(state.settings.providers) as SocialProvider[])
    .filter((provider) => state.settings.providers[provider]);
  state.sync = {
    running: true,
    startedAt: Date.now(),
    completed: 0,
    total: 0,
    automaticRetryPending: true,
  };
  await setState(state);
  const failures: string[] = [];

  try {
    await requireFreshAuth(state);
    for (const provider of providers) {
      state = await getState();
      state.sync.provider = provider;
      await setState(state);
      try {
        const firstRun = !state.providerFirstSyncDone[provider];
        // The first run only seeds the newest saves; afterwards every synced
        // URL sits in capturedUrls, so later runs stop scanning at the first
        // known item instead of re-walking the whole saved feed.
        const providerLimit = firstRun
          ? (state.settings.maxItemsPerProvider > 0
              ? Math.min(FIRST_SYNC_SEED_COUNT, state.settings.maxItemsPerProvider)
              : FIRST_SYNC_SEED_COUNT)
          : state.settings.maxItemsPerProvider;
        const stopUrls = firstRun
          ? []
          : state.capturedUrls.filter((url) => isSocialPostUrl(provider, url));
        const items = await collectProvider(provider, state.settings, providerLimit, stopUrls);
        const existingUrls = await existingSourceUrls(items.map((item) => item.url));
        let providerSaved = 0;
        let providerSkipped = 0;
        state = await getState();
        state.sync.total += items.length;
        await setState(state);

        for (const item of items) {
          if (syncCancellationRequested) break;
          const normalized = normalizeSavedUrl(item.url);
          if (!normalized) continue;
          if (!existingUrls.has(normalized)) {
            await saveItem(socialItemToOrbitItem({ ...item, url: normalized }), {
              dedupeUrl: normalized,
              recordActivity: false,
              knownNew: true,
            });
            providerSaved += 1;
          } else {
            providerSkipped += 1;
          }
          const progress = await getState();
          progress.sync.completed += 1;
          await setState(progress);
          await delay(jitteredDelayMs(250));
        }
        if (!syncCancellationRequested) {
          await markProviderSynced(provider, items.map((item) => item.url));
        }
        await addActivity({
          title: `${providerLabel(provider, state.settings)} automatic sync complete`,
          detail: firstRun
            ? `Seeded the ${providerSaved} newest save${providerSaved === 1 ? "" : "s"}; future runs pick up where this left off`
            : `${providerSaved} saved${providerSkipped ? `, ${providerSkipped} already in Orbb` : ""}`,
          platform: provider,
          status: "saved",
        });
      } catch (error) {
        if (syncCancellationRequested) break;
        failures.push(`${providerLabel(provider, state.settings)}: ${error instanceof Error ? error.message : String(error)}`);
        await addActivity({
          title: `${providerLabel(provider, state.settings)} sync needs attention`,
          detail: error instanceof Error ? error.message : String(error),
          platform: provider,
          status: "failed",
        });
      }
    }

    state = await getState();
    const retryPending = failures.length > 0 || syncCancellationRequested;
    state.sync = {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      lastRunAt: syncCancellationRequested ? state.sync.lastRunAt : Date.now(),
      lastError: failures.length > 0
        ? failures.join(" · ")
        : syncCancellationRequested ? "Automatic sync was interrupted." : undefined,
      automaticRetryPending: retryPending,
    };
    await setState(state);
    return state.sync;
  } catch (error) {
    state = await getState();
    state.sync = {
      ...state.sync,
      running: false,
      startedAt: undefined,
      provider: undefined,
      lastRunAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      automaticRetryPending: true,
    };
    await setState(state);
    throw error;
  }
}

/**
 * Records a completed provider run so the next scan can stop early.
 *
 * Every collected URL — saved or skipped — lands in capturedUrls, because the
 * stop-at-known scan only trusts the local list. Failed saves never reach this
 * point (they abort the provider), so an item that failed to upload stays
 * unknown and is retried on the next run.
 */
async function markProviderSynced(provider: SocialProvider, rawUrls: string[]): Promise<void> {
  const state = await getState();
  const urls = rawUrls
    .map((url) => normalizeSavedUrl(url))
    .filter((url): url is string => Boolean(url));
  state.capturedUrls = [...new Set([...urls, ...state.capturedUrls])].slice(0, MAX_CAPTURED_URLS);
  state.providerFirstSyncDone = { ...state.providerFirstSyncDone, [provider]: true };
  await setState(state);
}

async function existingSourceUrls(rawUrls: string[]): Promise<Set<string>> {
  const state = await getState();
  const auth = await requireFreshAuth(state);
  const urls = [...new Set(rawUrls.map((url) => normalizeSavedUrl(url)).filter((url): url is string => Boolean(url)))];
  const existing = new Set(state.capturedUrls.filter((url) => urls.includes(url)));
  if (urls.length === 0) return existing;
  let remote: Set<string>;
  try {
    remote = await createOrbitClient(
      state.apiBaseUrl,
      auth.accessToken,
    ).bookmarks.findExistingUrls(urls);
  } catch (error) {
    if (isAuthorizationRejection(error)) {
      await clearRejectedAuth(auth.accessToken);
    }
    throw error;
  }
  for (const url of remote) existing.add(url);
  return existing;
}

function isAuthorizationRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Orbit request failed:\s*(401|403)\b/.test(error.message)
  );
}

async function clearRejectedAuth(accessToken: string): Promise<void> {
  const state = await getState();
  if (state.auth?.accessToken !== accessToken) return;
  delete state.auth;
  delete state.qrSession;
  state.sync = {
    running: false,
    completed: 0,
    total: 0,
    lastRunAt: state.sync.lastRunAt,
    lastError: "Your Orbb connection expired. Scan a new login code.",
    automaticRetryPending: false,
  };
  await setState(state);
}

async function markAlreadySaved(items: SocialItem[]): Promise<SocialItem[]> {
  const existing = await existingSourceUrls(items.map((item) => item.url));
  return items.map((item) => {
    const normalized = normalizeSavedUrl(item.url);
    return { ...item, alreadySaved: Boolean(normalized && existing.has(normalized)) };
  });
}

async function collectProvider(
  provider: SocialProvider,
  settings: SyncSettings,
  limit: number,
  stopUrls: string[] = [],
): Promise<SocialItem[]> {
  const startPage = providerStartPage(provider, settings);
  if (!startPage) {
    throw new Error(`Add a page address for ${providerLabel(provider, settings)} in settings.`);
  }
  const origins = providerOrigins(provider, settings);
  const hasPermission = origins.length > 0 && await chrome.permissions.contains({ origins });
  if (!hasPermission) {
    throw new Error(
      `Allow ${providerLabel(provider, settings)} access before importing saved items.`,
    );
  }
  const tab = await chrome.tabs.create({ url: startPage, active: false });
  if (!tab.id) throw new Error(`Could not open ${providerLabel(provider, settings)}.`);
  activeSyncTabId = tab.id;
  try {
    throwIfSyncCancelled();
    await waitForTab(tab.id, 30_000);
    throwIfSyncCancelled();
    // A configured Instagram URL already points at the right saved page, so
    // the account-detection round trip is skipped entirely.
    if (provider === "instagram" && !settings.instagramUrl) {
      const usernameResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: resolveInstagramUsernameInPage,
      });
      const username = usernameResults[0]?.result;
      const savedPage = typeof username === "string" ? instagramSavedPageForUsername(username) : null;
      if (!savedPage) throw new Error("Could not determine the Instagram account signed into Chrome.");
      await chrome.tabs.update(tab.id, { url: savedPage });
      await waitForTab(tab.id, 30_000);
      throwIfSyncCancelled();
    }
    await delay(jitteredDelayMs(provider === "instagram" ? 1800 : 2800));
    throwIfSyncCancelled();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectSocialItemsInPage,
      args: [provider, limit, COLLECTION_BUDGET_MS, stopUrls],
    });
    const result = results[0]?.result as { ok: boolean; items?: SocialItem[]; error?: string } | undefined;
    if (!result?.ok) {
      throw new Error(
        result?.error || `Could not read ${providerLabel(provider, settings)} saves. Make sure you are logged in.`,
      );
    }
    const items = deduplicateSocialItems(result.items ?? []);
    return limit > 0 ? items.slice(0, limit) : items;
  } finally {
    if (activeSyncTabId === tab.id) activeSyncTabId = undefined;
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

function throwIfSyncCancelled(): void {
  if (syncCancellationRequested) throw new Error("Sync cancelled.");
}

async function resolveInstagramUsernameInPage(): Promise<string | null> {
  const headers = {
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
  };
  for (const endpoint of [
    "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
    "https://www.instagram.com/api/v1/accounts/current_user/?edit=true",
  ]) {
    try {
      const response = await fetch(endpoint, { credentials: "include", headers });
      if (!response.ok) continue;
      const data = await response.json();
      const username = data?.form_data?.username || data?.user?.username || data?.username;
      if (typeof username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(username)) return username;
    } catch {
      // Instagram changes its private web endpoints periodically; fall back to
      // the signed-in profile link already rendered in the navigation.
    }
  }

  const reserved = new Set(["accounts", "direct", "explore", "p", "reel", "reels", "stories", "your_activity"]);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const label = [
      link.getAttribute("aria-label"),
      link.textContent,
      link.querySelector("svg")?.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!label.includes("profile")) continue;
    try {
      const url = new URL(link.href, location.href);
      const segments = url.pathname.split("/").filter(Boolean);
      const username = segments.length === 1 ? segments[0] : undefined;
      if (username && !reserved.has(username) && /^[A-Za-z0-9._]{1,30}$/.test(username)) return username;
    } catch {
      // Ignore malformed navigation links.
    }
  }
  return null;
}

function collectSocialItemsInPage(
  provider: SocialProvider,
  limit: number,
  budgetMs: number,
  stopUrls: string[],
): Promise<{ ok: boolean; items?: SocialItem[]; error?: string }> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Same intent as jitteredDelayMs in shared.ts, re-declared because this
  // function is serialized into the page: evenly spaced scrolling reads as
  // scripted, so every pause varies.
  const jitter = (ms: number) => Math.max(1, Math.round(ms * (0.7 + Math.random() * 0.8)));
  const clean = (value: string, fallback: string) => value.replace(/\s+/g, " ").trim().slice(0, 180) || fallback;
  const cleanContent = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 4000);
  const reachedLimit = (count: number) => limit > 0 && count >= limit;
  const deadline = Date.now() + Math.max(30_000, budgetMs);

  // Mirrors normalizeSavedUrl/canonicalSocialPostUrl from shared.ts — this
  // function is serialized into the page, so it cannot import them. stopUrls
  // arrive already normalized; a mismatch here would defeat early stopping.
  const canonicalKey = (rawUrl: string): string => {
    try {
      const url = new URL(rawUrl, location.href);
      url.hash = "";
      url.search = "";
      const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
      if (hostname === "x.com" || hostname === "twitter.com") {
        const statusId = url.pathname.match(/\/status\/(\d+)/)?.[1];
        if (statusId) return `https://x.com/i/status/${statusId}`;
      }
      if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) {
        const segments = url.pathname.split("/").filter(Boolean);
        const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
        const postId = commentsIndex >= 0 ? segments[commentsIndex + 1]?.toLowerCase() : undefined;
        if (postId && /^[a-z0-9]+$/.test(postId)) {
          const commentId = segments[commentsIndex + 3]?.toLowerCase();
          return commentId && /^[a-z0-9]+$/.test(commentId)
            ? `https://www.reddit.com/comments/${postId}/_/${commentId}/`
            : `https://www.reddit.com/comments/${postId}/`;
        }
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  };
  const knownUrls = new Set(stopUrls);
  const isKnown = (url: string) => knownUrls.has(canonicalKey(url));
  // Distinguishes "nothing new since last sync" (success) from "nothing was
  // visible at all" (probably logged out) when zero items come back.
  let encounteredKnownItem = false;
  const budgetExpired = () => Date.now() >= deadline;

  const collectInstagram = async () => {
    const headers: Record<string, string> = {
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
      "X-ASBD-ID": "129477",
      Accept: "*/*",
    };
    const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1];
    if (csrf) headers["X-CSRFToken"] = decodeURIComponent(csrf);
    const getJson = async (url: string) => {
      const response = await fetch(url, { credentials: "include", headers });
      if (!response.ok) throw new Error(`Instagram returned ${response.status}. Open Instagram and confirm you are logged in.`);
      return response.json();
    };

    const folders: Array<{ id: string; title: string }> = [];
    try {
      const params = new URLSearchParams({ collection_types: '["MEDIA","ALL_MEDIA_AUTO_COLLECTION"]' });
      const data = await getJson(`https://www.instagram.com/api/v1/collections/list/?${params}`);
      for (const value of data.items || []) {
        const id = String(value.collection_id || "");
        const title = clean(value.collection_name || "", "Instagram folder");
        const type = String(value.collection_type || "").toUpperCase();
        if (id && type !== "ALL_MEDIA_AUTO_COLLECTION" && !/^audio$/i.test(title)) folders.push({ id, title });
      }
    } catch {
      // Folder discovery is best effort; all saved posts remains available.
    }
    folders.push({ id: "all-posts", title: "All saved" });

    const items: SocialItem[] = [];
    for (const folder of folders) {
      if (budgetExpired()) break;
      let cursor = "";
      // Each folder feed is newest-first, so hitting an already-synced post
      // means the rest of that folder was collected on a previous run.
      let reachedKnownItem = false;
      const maxPages = limit > 0 ? Math.min(200, Math.ceil(limit / 50) + 2) : 200;
      for (
        let page = 0;
        page < maxPages && !reachedLimit(items.length) && !budgetExpired() && !reachedKnownItem;
        page += 1
      ) {
        const endpoint = folder.id === "all-posts"
          ? "https://www.instagram.com/api/v1/feed/saved/posts/"
          : `https://www.instagram.com/api/v1/feed/collection/${folder.id}/posts/`;
        const params = new URLSearchParams({ count: "50" });
        if (cursor) params.set("max_id", cursor);
        let data;
        try {
          data = await getJson(`${endpoint}?${params}`);
        } catch (error) {
          if (folder.id === "all-posts" && items.length === 0) throw error;
          break;
        }
        for (const wrapped of data.items || []) {
          const media = wrapped.media || wrapped;
          const code = media.code || media.shortcode;
          if (!code) continue;
          const product = String(media.product_type || "").toLowerCase();
          const content = cleanContent(media.caption?.text || "");
          const postUrl = `https://www.instagram.com/${product === "clips" ? "reel" : "p"}/${code}/`;
          if (isKnown(postUrl)) {
            reachedKnownItem = true;
            encounteredKnownItem = true;
            break;
          }
          items.push({
            platform: "instagram",
            collection: folder.title,
            title: clean(content, product === "clips" ? "Instagram reel" : "Instagram post"),
            content: content || undefined,
            url: postUrl,
            coverImage: media.image_versions2?.candidates?.[0]?.url || media.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || "",
          });
          if (reachedLimit(items.length)) break;
        }
        cursor = data.next_max_id || data.next_cursor || data.paging_token || "";
        if (!(data.more_available || data.has_more_items) || !cursor) break;
      }
      if (reachedLimit(items.length)) break;
    }
    return items;
  };

  const collectDom = async () => {
    const found = new Map<string, SocialItem>();
    let stagnantPasses = 0;
    for (
      let pass = 0;
      pass < 1000 &&
      !reachedLimit(found.size) &&
      stagnantPasses < 8 &&
      !budgetExpired();
      pass += 1
    ) {
      const previousSize = found.size;
      // A custom source has no known post shape, so collection is limited to
      // the page's main content — scanning every anchor would sweep up the
      // site's own navigation and footer.
      const scope = provider === "custom"
        ? document.querySelector("main, article, [role='main'], #content") ?? document
        : document;
      const anchors = [...scope.querySelectorAll<HTMLAnchorElement>("a[href]")];
      for (const anchor of anchors) {
        let url: URL;
        try { url = new URL(anchor.href, location.href); } catch { continue; }
        const matches = provider === "reddit"
          ? /\/comments\/[a-z0-9]+\//i.test(url.pathname)
          : provider === "x"
            ? /\/status\/\d+/.test(url.pathname)
            : (url.protocol === "http:" || url.protocol === "https:")
              && url.href !== location.href
              && Boolean(anchor.textContent?.trim());
        if (!matches) continue;
        url.search = "";
        url.hash = "";
        if (isKnown(url.toString())) {
          // Finish scanning what is already rendered (new items sit above the
          // known one), then stop scrolling for more.
          encounteredKnownItem = true;
          continue;
        }
        const container = anchor.closest(provider === "x" ? "article" : "article, shreddit-post, [data-testid='post-container']");
        const text = provider === "x"
          ? container?.querySelector("[data-testid='tweetText']")?.textContent
          : anchor.textContent || container?.querySelector("h1,h2,h3,[slot='title']")?.textContent;
        const content = cleanContent(text || "");
        found.set(url.toString(), {
          platform: provider,
          title: clean(content, provider === "x" ? "X bookmark" : provider === "reddit" ? "Reddit saved post" : "Saved link"),
          content: content || undefined,
          url: url.toString(),
        });
        if (reachedLimit(found.size)) break;
      }
      if (encounteredKnownItem) break;
      stagnantPasses = found.size === previousSize ? stagnantPasses + 1 : 0;
      const scrollRoot = document.scrollingElement || document.documentElement;
      window.scrollTo({ top: scrollRoot.scrollHeight, behavior: "instant" });
      await sleep(jitter(1000));
    }
    return [...found.values()];
  };

  return (async () => {
    try {
      const items = provider === "instagram" ? await collectInstagram() : await collectDom();
      if (items.length === 0 && !encounteredKnownItem) {
        return {
          ok: false,
          error: provider === "custom"
            ? "No links were found on that page. Check the address, and that the page shows content without signing in again."
            : `No ${provider} saves were visible. Confirm you are logged in and have saved items.`,
        };
      }
      return { ok: true, items };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();
}

function deduplicateSocialItems(items: SocialItem[]): SocialItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const url = normalizeSavedUrl(item.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    item.url = url;
    return true;
  });
}

function waitForTab(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("The saved-items page took too long to load.")), timeoutMs);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const removedListener = (removedTabId: number) => {
      if (removedTabId === tabId) finish(new Error(syncCancellationRequested ? "Sync cancelled." : "The saved-items tab was closed."));
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(() => undefined);
  });
}

function providerLabel(provider: SocialProvider, settings?: SyncSettings): string {
  return providerDisplayName(provider, settings);
}

function normalizeSyncLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(10, Math.floor(value));
}

async function addActivity(item: Omit<ActivityItem, "id" | "createdAt">): Promise<void> {
  const state = await getState();
  state.activity = [{ ...item, id: crypto.randomUUID(), createdAt: Date.now() }, ...state.activity].slice(0, MAX_ACTIVITY);
  await setState(state);
}

async function getState(): Promise<StoredState> {
  const result = await chrome.storage.local.get(STATE_KEY);
  return mergeStoredState((result[STATE_KEY] ?? {}) as Partial<StoredState>);
}

async function setState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  void chrome.runtime.sendMessage({ type: "ORBB_STATE_UPDATED" }).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
