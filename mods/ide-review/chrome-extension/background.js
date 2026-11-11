const BRIDGE_BASE = "http://127.0.0.1:17501";
const EXPECTED_SCRIPT_VERSION = "1.4.1";

async function reinjectOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["page-hook.js"],
          world: "MAIN",
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
          world: "ISOLATED",
        });
      } catch {}
    }
  } catch {}
}

async function sendHeartbeat() {
  try {
    const manifest = chrome.runtime.getManifest();
    const res = await fetch(`${BRIDGE_BASE}/api/ext-heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extId: chrome.runtime.id,
        name: manifest.name,
        version: manifest.version,
      }),
    });
    const data = await res.json();
    if (data?.shouldReload) {
      chrome.runtime.reload();
    }
  } catch {
    // Bridge might not be running yet
  }
}

chrome.runtime.onInstalled.addListener(() => {
  sendHeartbeat();
  reinjectOpenTabs();
  chrome.alarms.create("herdr-heartbeat", { periodInMinutes: 0.25 });
});

chrome.runtime.onStartup.addListener(() => {
  sendHeartbeat();
  chrome.alarms.create("herdr-heartbeat", { periodInMinutes: 0.25 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === "herdr-heartbeat") {
    sendHeartbeat();
  }
});

// Immediately ping on service worker wake
sendHeartbeat();

async function toggleAnnotatorInTab(tab) {
  if (!tab?.id) return;
  sendHeartbeat();
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, {
      type: "HERDR_PING_VERSION",
    });
    if (ping?.version !== EXPECTED_SCRIPT_VERSION) {
      throw new Error("Version mismatch");
    }
    await chrome.tabs.sendMessage(tab.id, { type: "HERDR_TOGGLE_ANNOTATOR" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["page-hook.js"],
        world: "MAIN",
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
        world: "ISOLATED",
      });
      await chrome.tabs.sendMessage(tab.id, { type: "HERDR_TOGGLE_ANNOTATOR" });
    } catch (err) {
      console.warn("[Herdr Annotator] Cannot inject into this tab:", err);
    }
  }
}

chrome.action.onClicked.addListener(tab => {
  toggleAnnotatorInTab(tab);
});

chrome.commands.onCommand.addListener(async command => {
  if (command === "toggle-annotator") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) toggleAnnotatorInTab(tab);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "HERDR_BRIDGE_STATUS") {
    sendHeartbeat();
    fetch(`${BRIDGE_BASE}/api/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err =>
        sendResponse({ ok: false, error: String(err?.message || err) }),
      );
    return true;
  }

  if (msg.type === "HERDR_CAPTURE_AND_SEND") {
    (async () => {
      try {
        let screenshotDataUrl = null;
        if (msg.captureScreenshot !== false && sender.tab?.windowId != null) {
          try {
            screenshotDataUrl = await chrome.tabs.captureVisibleTab(
              sender.tab.windowId,
              { format: "png" },
            );
          } catch (capErr) {
            console.warn("[Herdr Annotator] captureVisibleTab failed:", capErr);
          }
        }

        const payload = {
          ...msg.payload,
          screenshotDataUrl,
        };

        const res = await fetch(`${BRIDGE_BASE}/api/annotations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        sendResponse({ ok: Boolean(data?.ok), data, screenshotDataUrl });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err?.message || err),
        });
      }
    })();
    return true;
  }

  if (msg.type === "HERDR_CLEAR_AGENT_ANNOTATIONS") {
    fetch(`${BRIDGE_BASE}/api/annotations/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTerminal: msg.targetTerminal || null }),
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err =>
        sendResponse({ ok: false, error: String(err?.message || err) }),
      );
    return true;
  }

  return false;
});
