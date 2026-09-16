export function errorMessage(error: unknown): string {
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
  if (message.includes("instagram folders could not be loaded")) {
    return "Instagram folder discovery failed. Open Instagram in this browser and confirm Saved collections load, then retry.";
  }
  if (message.includes("429") || message.includes("rate_limit")) return "Too many requests. Wait a few minutes before trying the import again.";
  if (message.includes("quota_exceeded")) return "Orbb rejected the import because a usage limit was reached.";
  if (message.includes("401") || message.includes("403") || message.includes("unauthorized")) {
    return message.includes("instagram")
      ? "Instagram refused access. Open Instagram in this browser and confirm you are signed in."
      : "Orbb could not authorize the request. Reconnect Orbb with a new QR code.";
  }
  if (message.includes("allow ") && message.includes("access before importing")) return "Allow this extension access to Instagram before importing.";
  if (message.includes("unexpected token") || message.includes("json")) return "The import received an unexpected response. Open Instagram in this browser and check for a login or verification prompt.";
  if (message.includes("receiving end does not exist") || message.includes("message port closed") || message.includes("message channel closed") || message.includes("orbb did not respond")) return "The extension stopped responding. Reload it in the extensions page, reopen the side panel, and retry.";
  if (message.includes("failed to fetch") || message.includes("networkerror") || message.includes("timeout") || message.includes("timed out")) return "An import request failed or timed out. Check that Instagram and Orbb are reachable, then retry.";
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

