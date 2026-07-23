import QRCode from "qrcode";
import type { CreateOrbitItemRequest } from "@orbb/orbit-sdk";
import {
  extractDroppedHttpUrl,
  MAX_DROP_BYTES,
  platformForUrl,
  PROVIDER_ORIGINS,
} from "./shared";
import type { BackgroundRequest, BackgroundResponse, SocialItem, SocialProvider, UiStoredState } from "./types";

interface Snapshot {
  state: UiStoredState;
  currentTab: { title: string; url: string } | null;
}

interface DropPreviewItem {
  id: string;
  kind: "url" | "image" | "audio" | "file" | "text";
  title: string;
  detail: string;
  item: CreateOrbitItemRequest;
  dedupeUrl?: string;
  previewUrl?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
}

const elements = {
  loginView: byId("loginView"),
  loginStart: byId("loginStart"),
  qrCard: byId("qrCard"),
  qrImage: byId<HTMLImageElement>("qrImage"),
  authStatus: byId("authStatus"),
  openAppLink: byId<HTMLAnchorElement>("openAppLink"),
  connectButton: byId<HTMLButtonElement>("connectButton"),
  cancelLoginButton: byId<HTMLButtonElement>("cancelLoginButton"),
  appView: byId("appView"),
  syncPreviewView: byId("syncPreviewView"),
  dropPreviewView: byId("dropPreviewView"),
  settingsView: byId("settingsView"),
  settingsButton: byId<HTMLButtonElement>("settingsButton"),
  settingsBackButton: byId<HTMLButtonElement>("settingsBackButton"),
  currentPageTitle: byId("currentPageTitle"),
  currentPageHost: byId("currentPageHost"),
  currentPageFavicon: byId("currentPageFavicon"),
  currentPageStatus: byId("currentPageStatus"),
  savePageButton: byId<HTMLButtonElement>("savePageButton"),
  dropZone: byId("dropZone"),
  fileInput: byId<HTMLInputElement>("fileInput"),
  scheduleSelect: byId<HTMLSelectElement>("scheduleSelect"),
  automationDescription: byId("automationDescription"),
  syncSummary: byId("syncSummary"),
  syncProgress: byId<HTMLProgressElement>("syncProgress"),
  syncMessage: byId("syncMessage"),
  activityList: byId("activityList"),
  emptyActivity: byId("emptyActivity"),
  accountAvatar: byId("accountAvatar"),
  accountAvatarImage: byId<HTMLImageElement>("accountAvatarImage"),
  accountAvatarFallback: byId("accountAvatarFallback"),
  settingsAvatar: byId("settingsAvatar"),
  settingsAvatarImage: byId<HTMLImageElement>("settingsAvatarImage"),
  settingsAvatarFallback: byId("settingsAvatarFallback"),
  settingsName: byId("settingsName"),
  settingsEmail: byId("settingsEmail"),
  instagramToggle: byId<HTMLInputElement>("instagramToggle"),
  redditToggle: byId<HTMLInputElement>("redditToggle"),
  xToggle: byId<HTMLInputElement>("xToggle"),
  signOutButton: byId<HTMLButtonElement>("signOutButton"),
  previewBackButton: byId<HTMLButtonElement>("previewBackButton"),
  previewTitle: byId("previewTitle"),
  previewSummary: byId("previewSummary"),
  previewToggleButton: byId<HTMLButtonElement>("previewToggleButton"),
  previewList: byId("previewList"),
  previewProgress: byId<HTMLProgressElement>("previewProgress"),
  previewActionStatus: byId("previewActionStatus"),
  previewSaveButton: byId<HTMLButtonElement>("previewSaveButton"),
  dropPreviewBackButton: byId<HTMLButtonElement>("dropPreviewBackButton"),
  dropPreviewSummary: byId("dropPreviewSummary"),
  dropPreviewList: byId("dropPreviewList"),
  dropPreviewProgress: byId<HTMLProgressElement>("dropPreviewProgress"),
  dropPreviewActionStatus: byId("dropPreviewActionStatus"),
  dropPreviewSaveButton: byId<HTMLButtonElement>("dropPreviewSaveButton"),
  clearActivityButton: byId<HTMLButtonElement>("clearActivityButton"),
  feedbackBanner: byId("feedbackBanner"),
  feedbackMessage: byId("feedbackMessage"),
  feedbackDismissButton: byId<HTMLButtonElement>("feedbackDismissButton"),
  toast: byId("toast"),
};

let snapshot: Snapshot | null = null;
let pollTimer: number | undefined;
let pollGeneration = 0;
let toastTimer: number | undefined;
let activeView: "app" | "settings" | "preview" | "dropPreview" = "app";
let previewProvider: SocialProvider | null = null;
let previewItems: SocialItem[] = [];
let selectedPreviewUrls = new Set<string>();
let dropPreviewItems: DropPreviewItem[] = [];
let activeManualSyncProvider: SocialProvider | null = null;
let manualSyncCancelled = false;

elements.connectButton.addEventListener("click", () => void beginLogin());
elements.cancelLoginButton.addEventListener("click", () => void cancelLogin());
elements.savePageButton.addEventListener("click", () => void saveCurrentPage());
elements.settingsButton.addEventListener("click", () => showSettings(true));
elements.settingsBackButton.addEventListener("click", () => showSettings(false));
elements.previewBackButton.addEventListener("click", () => closeSyncPreview());
elements.previewToggleButton.addEventListener("click", () => togglePreviewSelection());
elements.previewSaveButton.addEventListener("click", () => void saveSyncPreview());
elements.dropPreviewBackButton.addEventListener("click", () => closeDropPreview());
elements.dropPreviewSaveButton.addEventListener("click", () => void saveDropPreview());
elements.clearActivityButton.addEventListener("click", () => void clearActivity());
elements.feedbackDismissButton.addEventListener("click", () => dismissFeedback());
elements.signOutButton.addEventListener("click", () => void signOut());
elements.scheduleSelect.addEventListener("change", () => void updateSchedule());
elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  if (elements.fileInput.files) void previewDroppedFiles([...elements.fileInput.files]);
  elements.fileInput.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => void handleDrop(event));

document.querySelectorAll<HTMLButtonElement>(".sync-button").forEach((button) => {
  button.addEventListener("click", () => {
    const provider = button.dataset.provider as SocialProvider;
    if (button.dataset.action === "cancel") void cancelSync();
    else void runSync(provider);
  });
});

for (const [provider, input] of [
  ["instagram", elements.instagramToggle],
  ["reddit", elements.redditToggle],
  ["x", elements.xToggle],
] as const) {
  input.addEventListener("change", () => void updateProvider(provider, input.checked));
}

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message.type === "ORBB_STATE_UPDATED") void refresh();
});

async function beginLogin(): Promise<void> {
  setBusy(elements.connectButton, true, "Creating code…");
  elements.authStatus.textContent = "Creating a secure login code…";
  try {
    const session = await send<{ qrImageUrl?: string; verificationUriComplete: string }>({ type: "BEGIN_QR_AUTH" });
    showQr(session.qrImageUrl, session.verificationUriComplete);
    startPolling();
  } catch (error) {
    showToast(errorMessage(error), true);
    elements.authStatus.textContent = "A login code could not be created. Try again.";
  } finally {
    setBusy(elements.connectButton, false, "Show login code");
  }
}

function showQr(imageUrl?: string, appUrl?: string): void {
  elements.loginStart.hidden = true;
  elements.qrCard.hidden = false;
  elements.authStatus.textContent = "Waiting for approval in the Orbb app…";
  if (imageUrl) {
    elements.qrImage.src = imageUrl;
  } else if (appUrl) {
    void QRCode.toDataURL(appUrl, { width: 256, margin: 1, errorCorrectionLevel: "M" })
      .then((value) => { elements.qrImage.src = value; })
      .catch(() => {
        elements.authStatus.textContent = "The login code could not be rendered. Use Open Orbb app or try again.";
        showToast("Could not render the login code. Try again.", true);
      });
  }
  if (appUrl) elements.openAppLink.href = appUrl;
}

function startPolling(): void {
  stopPolling();
  const generation = ++pollGeneration;
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      const result = await send<{ status: string }>({ type: "POLL_QR_AUTH" });
      if (generation !== pollGeneration) return;
      if (result.status === "authorized") {
        stopPolling();
        elements.authStatus.textContent = "Chrome is connected to Orbb.";
        showToast("Chrome is connected to Orbb");
        await refresh();
      } else if (["expired", "cancelled", "consumed", "failed"].includes(result.status)) {
        stopPolling();
        if (result.status === "failed") await send({ type: "CANCEL_QR_AUTH" }).catch(() => undefined);
        resetLogin();
        const statusMessage = result.status === "expired"
          ? "The login code expired. Create a new one to continue."
          : result.status === "consumed"
            ? "That login code has already been used. Create a new one to continue."
            : result.status === "failed"
              ? "Authorization failed. Create a new code and try again."
              : "Login was cancelled. Create a new code when you are ready.";
        showToast(statusMessage, true);
      } else {
        elements.authStatus.textContent = "Waiting for approval in the Orbb app…";
        pollTimer = window.setTimeout(() => void poll(), 2100);
      }
    } catch (error) {
      if (generation !== pollGeneration) return;
      stopPolling();
      await send({ type: "CANCEL_QR_AUTH" }).catch(() => undefined);
      elements.authStatus.textContent = "Authorization failed. Create a new code and try again.";
      showToast(errorMessage(error), true);
    }
  };
  void poll();
}

function stopPolling(): void {
  pollGeneration += 1;
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

async function cancelLogin(): Promise<void> {
  stopPolling();
  await send({ type: "CANCEL_QR_AUTH" }).catch(() => undefined);
  resetLogin();
}

function resetLogin(): void {
  elements.loginStart.hidden = false;
  elements.qrCard.hidden = true;
  elements.qrImage.removeAttribute("src");
  elements.authStatus.textContent = "Waiting for approval…";
}

async function saveCurrentPage(): Promise<void> {
  setBusy(elements.savePageButton, true);
  elements.currentPageStatus.textContent = "Saving the current page…";
  try {
    const result = await send<{ saved: boolean; duplicate?: boolean }>({ type: "SAVE_CURRENT_PAGE" });
    const message = result.duplicate ? "This page is already in Orbb" : "Page saved to Orbb";
    elements.currentPageStatus.textContent = message;
    showToast(message);
  } catch (error) {
    const message = errorMessage(error);
    elements.currentPageStatus.textContent = message;
    showToast(message, true);
  } finally {
    setBusy(elements.savePageButton, false);
  }
}

async function handleDrop(event: DragEvent): Promise<void> {
  const transfer = event.dataTransfer;
  if (!transfer) return;

  const html = transfer.getData("text/html");
  let htmlUrl: string | null = null;
  let htmlTitle: string | undefined;
  let htmlType: "url" | "image" = "url";
  if (html) {
    const document = new DOMParser().parseFromString(html, "text/html");
    const image = document.querySelector<HTMLImageElement>("img[src]");
    const anchor = document.querySelector<HTMLAnchorElement>("a[href]");
    const imageUrl = extractDroppedHttpUrl(image?.getAttribute("src") || image?.src);
    const anchorUrl = extractDroppedHttpUrl(anchor?.getAttribute("href") || anchor?.href);
    if (imageUrl) {
      htmlUrl = imageUrl;
      htmlType = "image";
    } else if (anchorUrl) {
      htmlUrl = anchorUrl;
      htmlTitle = anchor?.textContent?.trim() || undefined;
    }
  }

  // Chrome can expose a dragged address as both URL text and a synthetic file.
  // Prefer the URL payload so an address-bar drag is saved as a bookmark.
  const textUrl = extractDroppedHttpUrl(
    transfer.getData("text/uri-list"),
    transfer.getData("text/x-moz-url"),
    transfer.getData("text/plain"),
    transfer.getData("DownloadURL"),
  );
  const url = htmlType === "image" ? htmlUrl : textUrl || htmlUrl;
  if (url) {
    previewDroppedUrl(url, htmlType === "image" && url === htmlUrl ? "image" : "url", htmlTitle);
    return;
  }

  if (transfer.files.length > 0) {
    await previewDroppedFiles([...transfer.files]);
    return;
  }

  const text = transfer.getData("text/plain").trim();
  if (text) previewDroppedText(text);
}

function previewDroppedUrl(url: string, type: "url" | "image", title?: string): void {
  const captureId = crypto.randomUUID();
  const displayTitle = title?.trim().slice(0, 180) || (type === "image" ? "Dropped image" : hostFor(url));
  const item: CreateOrbitItemRequest = {
    source: { type, url, platform: platformForUrl(url), capturedAt: new Date().toISOString() },
    title: displayTitle,
    tags: ["chrome", "drop"],
    metadata: { importer: "orbb-chrome-extension", capture: "drop", idempotencyKey: `chrome-drop:${captureId}` },
    privacy: { scope: "private" },
  };
  openDropPreview([{
    id: captureId,
    kind: type,
    title: displayTitle,
    detail: url,
    item,
    dedupeUrl: url,
    previewUrl: type === "image" ? url : undefined,
  }]);
}

function previewDroppedText(text: string): void {
  const captureId = crypto.randomUUID();
  const item: CreateOrbitItemRequest = {
    source: { type: "note", text, platform: "chrome", capturedAt: new Date().toISOString() },
    title: text.slice(0, 72),
    content: { text },
    tags: ["chrome", "drop"],
    metadata: { importer: "orbb-chrome-extension", capture: "drop", idempotencyKey: `chrome-drop:${captureId}` },
    privacy: { scope: "private" },
  };
  openDropPreview([{
    id: captureId,
    kind: "text",
    title: text.slice(0, 72),
    detail: text,
    item,
  }]);
}

async function previewDroppedFiles(files: File[]): Promise<void> {
  const items: DropPreviewItem[] = [];
  for (const file of files) {
    if (file.size > MAX_DROP_BYTES) {
      showToast(`${file.name} is larger than 10 MB`, true);
      continue;
    }
    try {
      const captureId = crypto.randomUUID();
      const dataUrl = await readFileAsDataUrl(file);
      const type: "image" | "audio" | "file" = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file";
      const raw = type === "audio"
        ? { audioData: dataUrl, fileName: file.name, size: file.size }
        : type === "file"
          ? { fileData: dataUrl, dataUrl, fileName: file.name, size: file.size }
          : { dataUrl, fileName: file.name, size: file.size };
      const item: CreateOrbitItemRequest = {
        source: {
          type,
          mimeType: file.type || "application/octet-stream",
          platform: "chrome",
          capturedAt: new Date().toISOString(),
          raw,
        },
        title: file.name,
        tags: ["chrome", "drop", "file"],
        metadata: {
          importer: "orbb-chrome-extension",
          fileName: file.name,
          byteSize: file.size,
          idempotencyKey: `chrome-drop:${captureId}`,
        },
        privacy: { scope: "private" },
      };
      items.push({
        id: captureId,
        kind: type,
        title: file.name,
        detail: `${file.type || "application/octet-stream"} · ${formatBytes(file.size)}`,
        item,
        previewUrl: type === "image" || type === "audio" ? dataUrl : undefined,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
      });
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }
  if (items.length > 0) openDropPreview(items);
}

function openDropPreview(items: DropPreviewItem[]): void {
  dropPreviewItems = items;
  activeView = "dropPreview";
  resetProgress(elements.dropPreviewProgress);
  elements.dropPreviewActionStatus.textContent = "";
  renderDropPreview();
  applyViewVisibility(Boolean(snapshot?.state.auth));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeDropPreview(): void {
  dropPreviewItems = [];
  elements.dropPreviewList.replaceChildren();
  resetProgress(elements.dropPreviewProgress);
  elements.dropPreviewActionStatus.textContent = "";
  activeView = "app";
  applyViewVisibility(Boolean(snapshot?.state.auth));
}

function renderDropPreview(): void {
  elements.dropPreviewList.replaceChildren();
  elements.dropPreviewSummary.textContent = `${dropPreviewItems.length} item${dropPreviewItems.length === 1 ? "" : "s"} ready. Nothing is saved until you confirm.`;
  elements.dropPreviewSaveButton.textContent = dropPreviewItems.length === 1 ? "Save to Orbb" : `Save ${dropPreviewItems.length} items`;
  elements.dropPreviewSaveButton.disabled = dropPreviewItems.length === 0;
  for (const item of dropPreviewItems) {
    const row = document.createElement("article");
    row.className = "drop-preview-item";
    row.setAttribute("aria-label", `${titleCase(item.kind)} capture: ${item.title}`);
    const header = document.createElement("div");
    header.className = "drop-preview-header";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const kind = document.createElement("span");
    kind.className = "drop-preview-kind";
    kind.textContent = item.kind;
    header.append(title, kind);
    row.append(header);

    if (item.kind === "image" && item.previewUrl) {
      const image = document.createElement("img");
      image.className = "drop-preview-image";
      image.src = item.previewUrl;
      image.alt = item.title;
      image.referrerPolicy = "no-referrer";
      row.append(image);
    } else if (item.kind === "audio" && item.previewUrl) {
      const audio = document.createElement("audio");
      audio.className = "drop-preview-audio";
      audio.src = item.previewUrl;
      audio.controls = true;
      row.append(audio);
    } else if (item.kind === "file") {
      const file = document.createElement("div");
      file.className = "drop-preview-file";
      const icon = document.createElement("span");
      icon.className = "drop-preview-file-icon";
      icon.textContent = "↗";
      const copy = document.createElement("span");
      copy.className = "drop-preview-file-copy";
      const name = document.createElement("strong");
      name.textContent = item.fileName || item.title;
      const metadata = document.createElement("span");
      metadata.textContent = `${item.mimeType || "File"}${item.byteSize == null ? "" : ` · ${formatBytes(item.byteSize)}`}`;
      copy.append(name, metadata);
      file.append(icon, copy);
      row.append(file);
    }

    const detail = document.createElement("p");
    detail.className = "drop-preview-detail";
    detail.textContent = item.detail;
    row.append(detail);
    elements.dropPreviewList.append(row);
  }
}

async function saveDropPreview(): Promise<void> {
  if (dropPreviewItems.length === 0) return;
  const pending = [...dropPreviewItems];
  const failed: DropPreviewItem[] = [];
  let saved = 0;
  let duplicates = 0;
  setBusy(elements.dropPreviewSaveButton, true, "Saving…");
  showProgress(elements.dropPreviewProgress, 0, pending.length);
  elements.dropPreviewActionStatus.textContent = `Saving 0 of ${pending.length}…`;
  try {
    for (const [index, item] of pending.entries()) {
      elements.dropPreviewSaveButton.textContent = `Saving ${index + 1}/${pending.length}…`;
      elements.dropPreviewActionStatus.textContent = `Saving ${index + 1} of ${pending.length}…`;
      try {
        const result = await send<{ duplicate?: boolean }>({
          type: "SAVE_ITEM",
          item: item.item,
          dedupeUrl: item.dedupeUrl,
        });
        if (result.duplicate) duplicates += 1;
        else saved += 1;
      } catch {
        failed.push(item);
      }
      showProgress(elements.dropPreviewProgress, index + 1, pending.length);
    }
    if (failed.length > 0) {
      dropPreviewItems = failed;
      renderDropPreview();
    } else {
      closeDropPreview();
      await refresh();
    }
    const result = [
      saved ? `${saved} saved` : "",
      duplicates ? `${duplicates} already in Orbb` : "",
      failed.length ? `${failed.length} failed` : "",
    ].filter(Boolean).join(" · ");
    elements.dropPreviewActionStatus.textContent = failed.length > 0
      ? `${result}. Review the failed items and retry.`
      : result;
    showToast(result, failed.length > 0);
  } finally {
    resetProgress(elements.dropPreviewProgress);
    setBusy(elements.dropPreviewSaveButton, false);
    if (failed.length > 0) {
      renderDropPreview();
      elements.dropPreviewSaveButton.textContent = failed.length === 1 ? "Retry failed item" : `Retry ${failed.length} failed items`;
    }
  }
}

async function runSync(provider: SocialProvider): Promise<void> {
  if (!(await ensureProviderPermissions([provider]))) return;
  activeManualSyncProvider = provider;
  manualSyncCancelled = false;
  setSyncButtons(true, provider);
  showProgress(elements.syncProgress);
  elements.syncMessage.hidden = true;
  showToast(`Collecting ${provider === "x" ? "X" : titleCase(provider)} saves for review…`);
  try {
    const items = await send<SocialItem[]>({ type: "PREVIEW_SYNC", provider });
    openSyncPreview(provider, items);
    showToast(`${items.length} item${items.length === 1 ? "" : "s"} captured — review before saving`);
  } catch (error) {
    if (!manualSyncCancelled && errorMessage(error) !== "Sync cancelled.") showToast(errorMessage(error), true);
  } finally {
    if (activeManualSyncProvider === provider) activeManualSyncProvider = null;
    setSyncButtons(false);
    resetProgress(elements.syncProgress);
  }
}

async function cancelSync(): Promise<void> {
  manualSyncCancelled = true;
  const cancelButton = document.querySelector<HTMLButtonElement>('.sync-button[data-action="cancel"]');
  if (cancelButton) {
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling…";
  }
  try {
    await send({ type: "CANCEL_SYNC" });
    showToast("Sync cancelled");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    activeManualSyncProvider = null;
    setSyncButtons(false);
    resetProgress(elements.syncProgress);
    await refresh();
  }
}

function openSyncPreview(provider: SocialProvider, items: SocialItem[]): void {
  previewProvider = provider;
  previewItems = items.map((item) => ({ ...item, importId: item.importId || crypto.randomUUID() }));
  selectedPreviewUrls = new Set(previewItems.filter((item) => !item.alreadySaved).map((item) => item.url));
  activeView = "preview";
  resetProgress(elements.previewProgress);
  elements.previewActionStatus.textContent = "";
  elements.previewTitle.textContent = `${provider === "x" ? "X" : titleCase(provider)} captures`;
  renderPreviewItems();
  applyViewVisibility(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeSyncPreview(): void {
  previewProvider = null;
  previewItems = [];
  selectedPreviewUrls.clear();
  elements.previewList.replaceChildren();
  resetProgress(elements.previewProgress);
  elements.previewActionStatus.textContent = "";
  activeView = "app";
  applyViewVisibility(Boolean(snapshot?.state.auth));
}

function renderPreviewItems(): void {
  elements.previewList.replaceChildren();
  if (previewItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const heading = document.createElement("h2");
    heading.textContent = "No new saves found";
    const description = document.createElement("p");
    description.textContent = "Check that you are signed in to this provider and have saved items, then try importing again.";
    empty.append(heading, description);
    elements.previewList.append(empty);
  }
  for (const item of previewItems) {
    const row = document.createElement("label");
    row.className = "preview-row";
    if (item.alreadySaved) row.classList.add("is-saved");
    const thumbnail = document.createElement("span");
    thumbnail.className = "preview-thumb";
    thumbnail.textContent = item.platform === "x" ? "X" : item.platform.slice(0, 1).toUpperCase();
    if (item.coverImage && /^https?:\/\//i.test(item.coverImage)) {
      const image = document.createElement("img");
      image.src = item.coverImage;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      thumbnail.append(image);
    }
    const copy = document.createElement("span");
    copy.className = "preview-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.textContent = item.alreadySaved ? "Already in Orbb" : item.collection || hostFor(item.url);
    copy.append(title, detail);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPreviewUrls.has(item.url);
    checkbox.disabled = Boolean(item.alreadySaved);
    checkbox.setAttribute("aria-label", `Save ${item.title}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedPreviewUrls.add(item.url);
      else selectedPreviewUrls.delete(item.url);
      updatePreviewControls();
    });
    row.append(thumbnail, copy, checkbox);
    elements.previewList.append(row);
  }
  updatePreviewControls();
}

function togglePreviewSelection(): void {
  const saveableItems = previewItems.filter((item) => !item.alreadySaved);
  const selectAll = selectedPreviewUrls.size !== saveableItems.length;
  selectedPreviewUrls = new Set(selectAll ? saveableItems.map((item) => item.url) : []);
  elements.previewList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    if (!checkbox.disabled) checkbox.checked = selectAll;
  });
  updatePreviewControls();
}

function updatePreviewControls(): void {
  const selected = selectedPreviewUrls.size;
  const total = previewItems.length;
  const alreadySaved = previewItems.filter((item) => item.alreadySaved).length;
  const saveable = total - alreadySaved;
  elements.previewToggleButton.disabled = saveable === 0;
  elements.previewBackButton.disabled = false;
  elements.previewList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    if (!checkbox.closest(".is-saved")) checkbox.disabled = false;
  });
  elements.previewSummary.textContent = `${total} captured · ${selected} selected${alreadySaved ? ` · ${alreadySaved} already in Orbb` : ""}. Nothing is saved until you confirm.`;
  elements.previewToggleButton.textContent = saveable === 0 ? "All saved" : selected === saveable ? "Clear all" : "Select all";
  elements.previewSaveButton.textContent = selected ? `Save ${selected} selected` : "Select items to save";
  elements.previewSaveButton.disabled = selected === 0;
  elements.previewActionStatus.textContent = selected
    ? `${selected} item${selected === 1 ? "" : "s"} selected`
    : saveable === 0 ? "There are no new items to save" : "Select at least one item to continue";
}

async function saveSyncPreview(): Promise<void> {
  if (!previewProvider) return;
  const provider = previewProvider;
  const items = previewItems.filter((item) => selectedPreviewUrls.has(item.url));
  setBusy(elements.previewSaveButton, true, `Saving 0/${items.length}…`);
  showProgress(elements.previewProgress, 0, items.length);
  elements.previewActionStatus.textContent = `Saving 0 of ${items.length}…`;
  try {
    const result = await send<{ saved: number; skipped: number; failed: number }>({
      type: "SAVE_SYNC_PREVIEW",
      provider,
      items,
    });
    closeSyncPreview();
    await refresh();
    const detail = [
      `${result.saved} saved`,
      result.skipped ? `${result.skipped} already in Orbb` : "",
      result.failed ? `${result.failed} failed` : "",
    ].filter(Boolean).join(" · ");
    showToast(detail, result.failed > 0);
  } catch (error) {
    showToast(errorMessage(error), true);
    updatePreviewControls();
  } finally {
    setBusy(elements.previewSaveButton, false);
    if (activeView === "preview") resetProgress(elements.previewProgress);
  }
}

async function updateSchedule(): Promise<void> {
  const frequencyMinutes = Number(elements.scheduleSelect.value);
  try {
    if (frequencyMinutes > 0 && snapshot) {
      const providers = (
        Object.keys(snapshot.state.settings.providers) as SocialProvider[]
      ).filter((provider) => snapshot?.state.settings.providers[provider]);
      if (!(await ensureProviderPermissions(providers))) {
        elements.scheduleSelect.value = "0";
        return;
      }
    }
    await send({
      type: "UPDATE_SETTINGS",
      settings: { enabled: frequencyMinutes > 0, frequencyMinutes: frequencyMinutes || 360 },
    });
    await refresh();
    showToast(frequencyMinutes ? "Background collection scheduled" : "Background collection turned off");
  } catch (error) {
    showToast(errorMessage(error), true);
    await refresh();
  }
}

async function updateProvider(provider: SocialProvider, enabled: boolean): Promise<void> {
  try {
    if (enabled && !(await ensureProviderPermissions([provider]))) {
      const input = providerInput(provider);
      input.checked = false;
      return;
    }
    await send({ type: "UPDATE_SETTINGS", settings: { providers: { [provider]: enabled } } });
    await refresh();
  } catch (error) {
    showToast(errorMessage(error), true);
    await refresh();
  }
}

async function ensureProviderPermissions(
  providers: SocialProvider[],
): Promise<boolean> {
  const origins = [
    ...new Set(providers.flatMap((provider) => PROVIDER_ORIGINS[provider])),
  ];
  if (origins.length === 0) return true;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    showToast(
      "Chrome access is required to read saves from the selected provider.",
      true,
    );
  }
  return granted;
}

function providerInput(provider: SocialProvider): HTMLInputElement {
  if (provider === "instagram") return elements.instagramToggle;
  if (provider === "reddit") return elements.redditToggle;
  return elements.xToggle;
}

async function signOut(): Promise<void> {
  setBusy(elements.signOutButton, true, "Disconnecting…");
  try {
    await send({ type: "SIGN_OUT" });
    closeDropPreview();
    showSettings(false);
    await refresh();
    showToast("Chrome disconnected. Interrupted revocation retries automatically.");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    setBusy(elements.signOutButton, false, "Disconnect Chrome");
  }
}

async function clearActivity(): Promise<void> {
  setBusy(elements.clearActivityButton, true, "Clearing…");
  try {
    await send({ type: "CLEAR_ACTIVITY" });
    await refresh();
    showToast("Recent activity cleared");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    setBusy(elements.clearActivityButton, false, "Clear activity");
  }
}

async function refresh(): Promise<void> {
  try {
    snapshot = await send<Snapshot>({ type: "GET_SNAPSHOT" });
    render(snapshot);
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function render(value: Snapshot): void {
  const { state, currentTab } = value;
  const isLoggedIn = Boolean(state.auth);
  elements.loginView.hidden = isLoggedIn;
  if (!isLoggedIn) {
    activeView = "app";
    applyViewVisibility(false);
    if (state.qrSession) {
      showQr(state.qrSession.qrImageUrl, state.qrSession.verificationUriComplete);
      startPolling();
    } else {
      resetLogin();
    }
    return;
  }
  applyViewVisibility(true);
  stopPolling();

  if (currentTab) {
    elements.currentPageTitle.textContent = currentTab.title;
    elements.currentPageHost.textContent = hostFor(currentTab.url);
    elements.currentPageFavicon.textContent = hostFor(currentTab.url).slice(0, 1).toUpperCase();
    elements.currentPageStatus.textContent = "This page can be saved to Orbb.";
    elements.savePageButton.disabled = false;
  } else {
    elements.currentPageTitle.textContent = "Open a web page to save it";
    elements.currentPageHost.textContent = "Chrome pages cannot be captured";
    elements.currentPageFavicon.textContent = "↗";
    elements.currentPageStatus.textContent = "This browser page is unsupported and cannot be captured.";
    elements.savePageButton.disabled = true;
  }

  renderUser(state);
  renderSync(state);
  renderSettings(state);
  renderActivity(state);
}

function renderUser(state: UiStoredState): void {
  const user = state.auth?.user;
  if (!user) return;
  const name = user.displayName || user.email || "Orbb user";
  const initial = name.slice(0, 1).toUpperCase();
  renderAvatar(elements.accountAvatarImage, elements.accountAvatarFallback, user.photoURL, initial);
  renderAvatar(elements.settingsAvatarImage, elements.settingsAvatarFallback, user.photoURL, initial);
  elements.settingsName.textContent = name;
  elements.settingsEmail.textContent = user.email || "Connected to Orbb";
}

function renderSync(state: UiStoredState): void {
  setSyncButtons(state.sync.running, state.sync.provider || activeManualSyncProvider || undefined);
  const savingPreview = activeView === "preview" && state.sync.running && state.sync.provider === previewProvider;
  if (savingPreview) {
    const total = state.sync.total || selectedPreviewUrls.size;
    showProgress(elements.previewProgress, state.sync.completed, total);
    elements.previewSaveButton.disabled = true;
    elements.previewSaveButton.textContent = `Saving ${Math.min(state.sync.completed, total)}/${total}…`;
    elements.previewSummary.textContent = "Saving selected captures to Orbb. You can keep this panel open to watch progress.";
    elements.previewActionStatus.textContent = `Saving ${Math.min(state.sync.completed, total)} of ${total}…`;
    elements.previewToggleButton.disabled = true;
    elements.previewBackButton.disabled = true;
    elements.previewList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.disabled = true;
    });
  }
  if (state.sync.running) {
    const label = state.sync.provider === "x" ? "X" : titleCase(state.sync.provider || "saves");
    elements.syncSummary.textContent = `${label} ${state.sync.completed}/${state.sync.total || "…"}`;
    if (state.sync.total > 0) showProgress(elements.syncProgress, state.sync.completed, state.sync.total);
    else showProgress(elements.syncProgress);
  } else {
    elements.syncSummary.textContent = state.sync.lastRunAt ? `Synced ${relativeTime(state.sync.lastRunAt)}` : "Ready";
    resetProgress(elements.syncProgress);
  }
  elements.syncMessage.hidden = !state.sync.lastError;
  elements.syncMessage.textContent = state.sync.lastError
    ? state.sync.automaticRetryPending
      ? "The last scheduled collection was interrupted. Chrome will retry it automatically."
      : "The last collection did not finish. You can try importing again."
    : "";
  elements.scheduleSelect.value = state.settings.enabled ? String(state.settings.frequencyMinutes) : "0";
  elements.automationDescription.textContent = state.settings.enabled
    ? `${scheduleLabel(state.settings.frequencyMinutes)} — may open inactive tabs`
    : "Off — import manually";
}

function renderSettings(state: UiStoredState): void {
  elements.instagramToggle.checked = state.settings.providers.instagram;
  elements.redditToggle.checked = state.settings.providers.reddit;
  elements.xToggle.checked = state.settings.providers.x;
}

function renderActivity(state: UiStoredState): void {
  elements.activityList.replaceChildren();
  elements.emptyActivity.hidden = state.activity.length > 0;
  elements.clearActivityButton.hidden = state.activity.length === 0;
  elements.clearActivityButton.disabled = false;
  for (const item of state.activity.slice(0, 8)) {
    const row = document.createElement("li");
    row.className = `activity-item ${item.status}`;
    const copy = document.createElement("div");
    copy.className = "activity-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.textContent = item.status === "failed" ? "Could not complete this item. Try again." : item.detail;
    copy.append(title, detail);
    const meta = document.createElement("div");
    meta.className = "activity-meta";
    const status = document.createElement("span");
    status.className = "activity-state";
    status.dataset.status = item.status;
    status.textContent = `${activityStatusLabel(item.status)} · ${platformLabel(item.platform)}`;
    const time = document.createElement("time");
    time.className = "activity-time";
    time.dateTime = new Date(item.createdAt).toISOString();
    time.title = new Date(item.createdAt).toLocaleString();
    time.textContent = relativeTime(item.createdAt);
    meta.append(status, time);
    row.append(copy, meta);
    elements.activityList.append(row);
  }
}

function showSettings(show: boolean): void {
  activeView = show ? "settings" : "app";
  applyViewVisibility(Boolean(snapshot?.state.auth));
}

function applyViewVisibility(isLoggedIn: boolean): void {
  elements.appView.hidden = !isLoggedIn || activeView !== "app";
  elements.settingsView.hidden = !isLoggedIn || activeView !== "settings";
  elements.syncPreviewView.hidden = !isLoggedIn || activeView !== "preview";
  elements.dropPreviewView.hidden = !isLoggedIn || activeView !== "dropPreview";
  elements.settingsButton.hidden = !isLoggedIn || activeView !== "app";
}

function setSyncButtons(running: boolean, activeProvider?: SocialProvider): void {
  document.querySelectorAll<HTMLButtonElement>(".sync-button").forEach((button) => {
    const isActive = running && button.dataset.provider === activeProvider;
    const provider = button.dataset.provider as SocialProvider;
    button.disabled = running && !isActive;
    button.textContent = isActive ? "Cancel" : "Import";
    button.dataset.action = isActive ? "cancel" : "sync";
    button.classList.toggle("cancel", isActive);
    button.setAttribute("aria-label", isActive
      ? `Cancel ${platformLabel(provider)} import`
      : `Import saved items from ${platformLabel(provider)}`);
    button.setAttribute("aria-busy", String(isActive));
  });
}

function setBusy(button: HTMLButtonElement, busy: boolean, label?: string): void {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  if (label) button.textContent = label;
}

function showToast(message: string, error = false): void {
  if (toastTimer) window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  if (error) showPersistentFeedback(message);
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, error ? 5200 : 2800);
}

function showPersistentFeedback(message: string): void {
  elements.feedbackMessage.textContent = message;
  elements.feedbackBanner.hidden = false;
}

function dismissFeedback(): void {
  elements.feedbackBanner.hidden = true;
  elements.feedbackMessage.textContent = "";
}

function showProgress(element: HTMLProgressElement, value?: number, max = 1): void {
  element.hidden = false;
  element.max = Math.max(1, max);
  if (value == null) element.removeAttribute("value");
  else element.value = Math.min(Math.max(0, value), element.max);
}

function resetProgress(element: HTMLProgressElement): void {
  element.hidden = true;
  element.removeAttribute("value");
}

function renderAvatar(image: HTMLImageElement, fallback: HTMLElement, photoURL: string | undefined, initial: string): void {
  fallback.textContent = initial;
  if (!photoURL || !/^https?:\/\//i.test(photoURL)) {
    image.hidden = true;
    image.removeAttribute("src");
    fallback.hidden = false;
    return;
  }
  image.referrerPolicy = "no-referrer";
  image.src = photoURL;
  image.hidden = false;
  fallback.hidden = true;
  image.onerror = () => {
    image.hidden = true;
    image.removeAttribute("src");
    fallback.hidden = false;
  };
}

function scheduleLabel(minutes: number): string {
  if (minutes === 1) return "Every minute";
  if (minutes === 30) return "Every 30 minutes";
  if (minutes === 60) return "Every hour";
  if (minutes === 1440) return "Every day";
  return `Every ${Math.round(minutes / 60)} hours`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function hostFor(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "web"; }
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function platformLabel(platform: string): string {
  if (platform.toLowerCase() === "x") return "X";
  if (platform.toLowerCase() === "orbb") return "Orbb";
  if (platform.toLowerCase() === "chrome") return "Chrome";
  return titleCase(platform || "Web");
}

function activityStatusLabel(status: UiStoredState["activity"][number]["status"]): string {
  if (status === "saved") return "Saved";
  if (status === "skipped") return "Skipped";
  if (status === "failed") return "Failed";
  return "Syncing";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();
  if (message.includes("sync cancelled")) return "Sync cancelled.";
  if (message.includes("session expired")) return "Your Orbb session expired. Connect again with a new QR code.";
  if (message.includes("connect orbb before")) return "Connect Orbb before saving.";
  if (message.includes("chrome page cannot")) return "This Chrome page cannot be saved.";
  if (message.includes("another sync")) return "Another import is already running.";
  if (message.includes("select at least")) return "Select at least one captured item to save.";
  if (message.includes("no link was available")) return "No supported link was available to save.";
  if (message.includes("larger than 10 mb")) return raw;
  if (message.includes("instagram") && (message.includes("logged in") || message.includes("account") || message.includes("returned"))) {
    return "Open Instagram in Chrome, confirm you are signed in, then try again.";
  }
  if (message.includes("no reddit saves") || message.includes("no x saves")) {
    return "No saved items were visible. Confirm you are signed in to the provider and try again.";
  }
  if (message.includes("saved-items page took too long")) return "The saved-items page took too long to load. Try again.";
  if (message.includes("saved-items tab was closed")) return "The inactive collection tab was closed. Try the import again.";
  if (message.includes("could not read") && message.includes("saves")) {
    return "Could not read saved items from this provider. Confirm you are signed in and try again.";
  }
  if (message.includes("start qr login") || message.includes("login code")) {
    return "Could not continue QR login. Create a new code and try again.";
  }
  return "Something went wrong. Check your connection and try again.";
}

async function send<T = void>(request: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as BackgroundResponse<T>;
  if (!response?.ok) throw new Error(response?.error || "Orbb did not respond.");
  return response.data;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

void refresh();
