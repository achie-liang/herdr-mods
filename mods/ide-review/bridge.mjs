#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE_VERSION = "1.5.0";
const PORT = Number(process.env.HERDR_ANNOTATE_PORT || 17501);
const HOST = "127.0.0.1";
const MAX_BATCHES = 30;
const EXPECTED_EXT_ID = "gmgfppipckmjcfgfhlcokjpjmmobbopn";
let pendingExtReload = false;

const __filename = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const out = {
    mode: "serve",
    appHome:
      process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--daemon") out.mode = "daemon";
    else if (a === "--serve") out.mode = "serve";
    else if (a === "--check-ext") out.mode = "check-ext";
    else if (a === "--install-ext") out.mode = "install-ext";
    else if (a === "--update-ext") out.mode = "update-ext";
    else if (a === "--app-home" && argv[i + 1]) {
      out.appHome = argv[++i];
    }
  }
  return out;
}

function getExtensionDir(appHome) {
  return path.join(appHome, "mods", "ide-review", "chrome-extension");
}

function getBundledExtensionVersion(appHome) {
  const manifestPath = path.join(getExtensionDir(appHome), "manifest.json");
  const m = readJsonSafe(manifestPath, null);
  return String(m?.version || "1.0.0");
}

function compareVersions(v1, v2) {
  const a = String(v1 || "0")
    .split(".")
    .map(n => Number(n) || 0);
  const b = String(v2 || "0")
    .split(".")
    .map(n => Number(n) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function ensureDirs(appHome) {
  const baseDir = path.join(appHome, "data", "annotations");
  const shotsDir = path.join(baseDir, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const queueFile = path.join(baseDir, "queue.json");
  if (!fs.existsSync(queueFile)) {
    fs.writeFileSync(queueFile, JSON.stringify({ batches: [] }, null, 2));
  }
  return {
    baseDir,
    shotsDir,
    queueFile,
    commandFile: path.join(baseDir, "command.json"),
    contextFile: path.join(baseDir, "context.json"),
    bridgeFile: path.join(baseDir, "bridge.json"),
    extStatusFile: path.join(baseDir, "ext-status.json"),
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function scanBrowserProfilesForExtension(appHome) {
  const extDir = getExtensionDir(appHome);
  const home = os.homedir();
  const browserRoots = [
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Google", "Chrome Canary"),
    path.join(home, "Library", "Application Support", "Arc", "User Data"),
    path.join(
      home,
      "Library",
      "Application Support",
      "BraveSoftware",
      "Brave-Browser",
    ),
    path.join(home, "Library", "Application Support", "Microsoft Edge"),
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
  ];

  for (const root of browserRoots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== "Default" && !entry.name.startsWith("Profile ")) {
        continue;
      }
      const profileDir = path.join(root, entry.name);
      for (const prefName of ["Secure Preferences", "Preferences"]) {
        const prefPath = path.join(profileDir, prefName);
        if (!fs.existsSync(prefPath)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(prefPath, "utf8"));
          const settings = data?.extensions?.settings;
          if (!settings || typeof settings !== "object") continue;

          for (const [id, info] of Object.entries(settings)) {
            if (!info || typeof info !== "object") continue;
            const extPath = String(info.path || "");
            const name = String(info.manifest?.name || "");
            const isMatch =
              id === EXPECTED_EXT_ID ||
              name === "Herdr UI Review" ||
              name === "Herdr Browser Annotator" ||
              extPath === extDir ||
              (extPath.endsWith("chrome-extension") &&
                (extPath.includes("ide-review") ||
                  extPath.includes("ide-annotate") ||
                  extPath.includes("herdr-mods")));

            if (isMatch) {
              const enabled = info.state === undefined ? true : info.state === 1;
              return {
                installedInProfile: true,
                enabled,
                extId: id,
                version: info.manifest?.version || "1.0.0",
                installedPath: extPath,
                profile: `${path.basename(root)}/${entry.name}`,
              };
            }
          }
        } catch {}
      }
    }
  }

  return {
    installedInProfile: false,
    enabled: false,
    extId: EXPECTED_EXT_ID,
    version: null,
    installedPath: null,
    profile: null,
  };
}

function computeAndSaveExtStatus(appHome, heartbeatUpdate = null) {
  const paths = ensureDirs(appHome);
  const prev = readJsonSafe(paths.extStatusFile, {});
  const profileScan = scanBrowserProfilesForExtension(appHome);
  const extDir = getExtensionDir(appHome);
  const bundledVersion = getBundledExtensionVersion(appHome);

  const rawLastSeen = heartbeatUpdate?.lastSeenAt ?? prev.lastSeenAt ?? null;
  // If it was previously recorded in Chrome's profile and is now gone from Chrome's profile,
  // the user just uninstalled it in Chrome!
  const wasUninstalledFromProfile =
    !heartbeatUpdate &&
    Boolean(prev.installedInProfile) &&
    !profileScan.installedInProfile;

  const justInstalledGrace =
    !wasUninstalledFromProfile &&
    (Boolean(heartbeatUpdate) ||
      (!prev.installedInProfile &&
        Boolean(rawLastSeen) &&
        Date.now() - rawLastSeen < 30000));

  const installed = profileScan.installedInProfile || justInstalledGrace;
  const lastSeenAt = installed ? rawLastSeen : null;
  const connectedNow =
    installed &&
    (Boolean(heartbeatUpdate) ||
      (Boolean(lastSeenAt) && Date.now() - lastSeenAt < 1000 * 60));

  const heartbeatVersion = installed
    ? heartbeatUpdate?.version || prev.heartbeatVersion || null
    : null;
  const installedVersion = installed
    ? heartbeatVersion || profileScan.version || prev.installedVersion || null
    : null;

  const pathMismatch =
    installed &&
    Boolean(profileScan.installedPath) &&
    profileScan.installedPath !== extDir;
  const needsUpdate =
    installed &&
    (compareVersions(bundledVersion, installedVersion || "0.0.0") > 0 ||
      pathMismatch);

  const next = {
    installed,
    installedInProfile: profileScan.installedInProfile,
    enabled: installed
      ? profileScan.installedInProfile
        ? profileScan.enabled
        : true
      : false,
    connected: connectedNow,
    extId:
      heartbeatUpdate?.extId ||
      profileScan.extId ||
      prev.extId ||
      EXPECTED_EXT_ID,
    version: installedVersion || bundledVersion,
    heartbeatVersion,
    installedVersion,
    bundledVersion,
    needsUpdate,
    installedPath: installed
      ? profileScan.installedPath || extDir
      : null,
    extensionDir: extDir,
    profile: installed ? profileScan.profile || prev.profile || null : null,
    lastSeenAt,
    checkedAt: Date.now(),
  };

  const prevKey = JSON.stringify({
    installed: prev.installed,
    connected: prev.connected,
    extId: prev.extId,
    installedVersion: prev.installedVersion,
    bundledVersion: prev.bundledVersion,
    needsUpdate: prev.needsUpdate,
    profile: prev.profile,
  });
  const nextKey = JSON.stringify({
    installed: next.installed,
    connected: next.connected,
    extId: next.extId,
    installedVersion: next.installedVersion,
    bundledVersion: next.bundledVersion,
    needsUpdate: next.needsUpdate,
    profile: next.profile,
  });

  if (
    prevKey !== nextKey ||
    heartbeatUpdate ||
    !fs.existsSync(paths.extStatusFile)
  ) {
    writeJsonAtomic(paths.extStatusFile, next);
  }
  return next;
}

function copyToClipboardMac(text) {
  return new Promise(resolve => {
    const proc = spawn("pbcopy");
    proc.on("error", () => resolve(false));
    proc.on("close", code => resolve(code === 0));
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

function runAppleScript(script, args = [], timeoutMs = 12000) {
  return new Promise(resolve => {
    execFile(
      "osascript",
      ["-e", script, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
        });
      },
    );
  });
}

async function installChromeExtension(appHome) {
  const extDir = getExtensionDir(appHome);
  if (!fs.existsSync(extDir)) {
    return {
      ok: false,
      error: `Extension folder missing at ${extDir}`,
    };
  }

  const preStatus = computeAndSaveExtStatus(appHome);
  const alreadyAtTargetDir =
    preStatus.installedInProfile && preStatus.installedPath === extDir;

  // Always put the exact extension path onto clipboard first
  await copyToClipboardMac(extDir);

  const appleScript = `
on collectControls(el, depth)
  if depth > 7 then return {}
  set out to {}
  tell application "System Events"
    try
      set childrenList to UI elements of el
    on error
      return {}
    end try
    repeat with c in childrenList
      try
        set r to role of c
        if r is "AXButton" or r is "AXCheckBox" then
          set end of out to (contents of c)
        else if r is "AXGroup" then
          set sub to my collectControls(contents of c, depth + 1)
          set out to out & sub
        end if
      end try
    end repeat
  end tell
  return out
end collectControls

on findWebArea(winEl)
  tell application "System Events"
    try
      set g4 to group 1 of group 1 of group 1 of group 1 of winEl
      set webContainer to UI element 2 of g4
      repeat with g in groups of webContainer
        repeat with sa in scroll areas of g
          repeat with wa in UI elements of sa
            if (role of wa) is "AXWebArea" and ((name of wa as text) contains "扩展程序" or (name of wa as text) contains "Extensions") then
              return contents of wa
            end if
          end repeat
        end repeat
      end repeat
    end try
  end tell
  return missing value
end findWebArea

on run argv
  set onlyReload to (item 1 of argv) is "reload"

  tell application "Google Chrome"
    activate
    if (count of windows) is 0 or (mode of front window) is not "normal" then
      make new window
    end if
    set w to front window
    set foundTab to false
    set tabIdx to 1
    repeat with t in tabs of w
      if URL of t starts with "chrome://extensions" then
        set active tab index of w to tabIdx
        set foundTab to true
        exit repeat
      end if
      set tabIdx to tabIdx + 1
    end repeat
    if not foundTab then
      tell w to make new tab at end of tabs with properties {URL:"chrome://extensions/"}
    end if
  end tell

  delay 0.7

  try
    tell application "System Events"
      tell process "Google Chrome"
        set frontmost to true
        try
          set value of attribute "AXEnhancedUserInterface" to true
        end try
        delay 0.4

        set targetWin to window 1
        try
          perform action "AXRaise" of targetWin
        end try

        set wa to my findWebArea(targetWin)
        set elems to {}
        if wa is not missing value then
          set elems to my collectControls(wa, 0)
        end if

        -- If extension is already loaded from targetDir, click Reload & Update buttons directly
        if onlyReload and (count of elems) > 0 then
          set clickedReload to false
          set sawRemove to false
          repeat with el in elems
            try
              if (role of el) is "AXButton" then
                set n to (name of el) as text
                if n is "更新" or n is "Update" then
                  click el
                  set clickedReload to true
                else if n is "移除" or n is "Remove" then
                  set sawRemove to true
                else if sawRemove and (n is "重新加载" or n is "Reload") then
                  click el
                  set clickedReload to true
                  set sawRemove to false
                end if
              end if
            end try
          end repeat
          if clickedReload then
            return "AUTO_RELOADED"
          end if
        end if

        -- Otherwise toggle Developer Mode if needed and click Load Unpacked
        if (count of sheets of targetWin) is 0 then
          set loadBtn to missing value
          set devSwitch to missing value
          repeat with el in elems
            try
              set r to role of el
              set n to (name of el) as text
              if r is "AXCheckBox" and (n contains "开发者模式" or n contains "Developer mode") then
                set devSwitch to el
              else if r is "AXButton" and (n contains "加载未打包的扩展程序" or n contains "加载已解压的扩展程序" or n contains "Load unpacked") then
                set loadBtn to el
              end if
            end try
          end repeat

          if devSwitch is not missing value then
            try
              if (value of devSwitch as integer) is 0 then
                click devSwitch
                delay 0.45
              end if
            end try
          end if

          if loadBtn is missing value and wa is not missing value then
            set elems2 to my collectControls(wa, 0)
            repeat with el in elems2
              try
                set r2 to role of el
                set n2 to (name of el) as text
                if r2 is "AXButton" and (n2 contains "加载未打包的扩展程序" or n2 contains "加载已解压的扩展程序" or n2 contains "Load unpacked") then
                  set loadBtn to el
                  exit repeat
                end if
              end try
            end repeat
          end if

          if loadBtn is not missing value then
            click loadBtn
            delay 0.7
          end if
        end if

        -- Handle the macOS Open Folder sheet on targetWin
        if (count of sheets of targetWin) > 0 then
          if (count of sheets of sheet 1 of targetWin) is 0 then
            keystroke "g" using {command down, shift down}
            delay 0.55
          end if

          if (count of sheets of sheet 1 of targetWin) > 0 then
            set focused of text field 1 of sheet 1 of sheet 1 of targetWin to true
            delay 0.15
            keystroke "a" using {command down}
            delay 0.1
            keystroke "v" using {command down}
            delay 0.5
            key code 36
            delay 0.65
          end if

          if (count of sheets of targetWin) > 0 then
            repeat with b in buttons of splitter group 1 of sheet 1 of targetWin
              set bn to (name of b) as text
              if bn is "选择" or bn is "Select" or bn is "Open" or bn is "打开" then
                click b
                exit repeat
              end if
            end repeat
            delay 0.6
          end if
          return "AUTO_INSTALLED"
        end if
      end tell
    end tell
  on error errMsg
    return "FALLBACK:" & errMsg
  end try
  return "OPENED_EXTENSIONS_PAGE"
end run
`;

  const osaRes = await runAppleScript(
    appleScript,
    [alreadyAtTargetDir ? "reload" : "install"],
    12000,
  );

  // Give Chrome a moment to register the unpacked extension & fire onInstalled heartbeat
  await new Promise(r => setTimeout(r, 900));
  const status = computeAndSaveExtStatus(appHome);

  if (
    status.installed ||
    osaRes.stdout === "AUTO_INSTALLED" ||
    osaRes.stdout === "AUTO_RELOADED"
  ) {
    return {
      ok: true,
      mode: "auto",
      status,
      extensionDir: extDir,
      message: "Chrome extension installed/updated automatically!",
    };
  }

  // Fallback: also reveal the folder in Finder right next to chrome://extensions
  execFile("open", ["-R", extDir], () => {});

  return {
    ok: true,
    mode: "assisted",
    status,
    extensionDir: extDir,
    message:
      "Opened chrome://extensions & copied extension path to clipboard (drag the highlighted folder into Chrome or click Load unpacked → ⌘⇧G → ⌘V).",
  };
}

function httpGetJson(url, timeoutMs = 600) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function httpPostJson(url, body = {}, timeoutMs = 600) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => resolve(raw));
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

function queryHcTerminals() {
  return new Promise(resolve => {
    execFile("hc", ["ls", "--json"], { timeout: 1500 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.terminals)
            ? parsed.terminals
            : [];
        resolve(list);
      } catch {
        resolve([]);
      }
    });
  });
}

async function runDaemonBootstrap(appHome) {
  ensureDirs(appHome);
  computeAndSaveExtStatus(appHome);
  const ping = await httpGetJson(`http://${HOST}:${PORT}/api/ping`, 450);
  if (ping?.ok && ping?.version === BRIDGE_VERSION) {
    process.exit(0);
  }
  if (ping?.ok) {
    await httpPostJson(`http://${HOST}:${PORT}/api/shutdown`, {}, 450);
    await new Promise(r => setTimeout(r, 120));
  }
  const child = spawn(
    process.execPath,
    [__filename, "--serve", "--app-home", appHome],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HERDR_APP_HOME: appHome },
    },
  );
  child.unref();
  process.exit(0);
}

function sendCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function sendJson(res, status, obj) {
  sendCorsHeaders(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8");
        resolve(str ? JSON.parse(str) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function startServer(appHome) {
  const paths = ensureDirs(appHome);
  computeAndSaveExtStatus(appHome);

  const server = http.createServer(async (req, res) => {
    sendCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = urlObj.pathname;

    try {
      if (req.method === "GET" && pathname === "/api/ping") {
        sendJson(res, 200, {
          ok: true,
          version: BRIDGE_VERSION,
          pid: process.pid,
          port: PORT,
          appHome,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/shutdown") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }

      if (req.method === "POST" && pathname === "/api/ext-heartbeat") {
        const body = await readRequestBody(req);
        const shouldReload = pendingExtReload;
        if (pendingExtReload) {
          pendingExtReload = false;
        }
        const extStatus = computeAndSaveExtStatus(appHome, {
          extId: body.extId || EXPECTED_EXT_ID,
          version: body.version || "1.0.0",
          lastSeenAt: Date.now(),
        });
        sendJson(res, 200, { ok: true, shouldReload, extension: extStatus });
        return;
      }

      if (req.method === "POST" && pathname === "/api/request-reload") {
        pendingExtReload = true;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/ext-status") {
        const extStatus = computeAndSaveExtStatus(appHome);
        sendJson(res, 200, { ok: true, extension: extStatus });
        return;
      }

      if (
        req.method === "POST" &&
        (pathname === "/api/install-extension" ||
          pathname === "/api/update-extension")
      ) {
        pendingExtReload = true;
        const result = await installChromeExtension(appHome);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const ctx = readJsonSafe(paths.contextFile, null);
        const queue = readJsonSafe(paths.queueFile, { batches: [] });
        const extStatus = computeAndSaveExtStatus(appHome);
        let agents = Array.isArray(ctx?.agents) ? ctx.agents : [];
        if (!agents.length) {
          const rawTerms = await queryHcTerminals();
          agents = rawTerms
            .filter(t => t && (t.report?.app || t.state === "running"))
            .map(t => ({
              address: t.address || t.id,
              pane: null,
              space: "",
              spaceName: t.labels?.space || "",
              tabName: t.name || "",
              status: t.status || "idle",
              app:
                t.report?.app ||
                (Array.isArray(t.argv) ? t.argv[0] : "terminal"),
              programName: t.report?.app || t.name || t.address,
              title: t.title || t.name || t.address,
              focused: false,
            }));
        }
        sendJson(res, 200, {
          ok: true,
          version: BRIDGE_VERSION,
          port: PORT,
          appHome,
          cwd: ctx?.cwd || "",
          activeSpace: ctx?.activeSpace || null,
          focused: ctx?.focused || null,
          agents,
          queueCount: (queue.batches || []).length,
          extension: extStatus,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/annotations") {
        const queue = readJsonSafe(paths.queueFile, { batches: [] });
        sendJson(res, 200, { ok: true, batches: queue.batches || [] });
        return;
      }

      if (req.method === "POST" && pathname === "/api/annotations") {
        const body = await readRequestBody(req);
        const now = Date.now();
        const queue = readJsonSafe(paths.queueFile, { batches: [] });
        const existing = Array.isArray(queue.batches) ? queue.batches : [];
        const targetTerminal = body.targetTerminal || "default";

        // Match existing batch by (url, targetTerminal) when replaceSameUrl !== false
        const sameUrlBatch =
          body.replaceSameUrl !== false && body.url
            ? existing.find(
                b =>
                  b.url === body.url &&
                  (b.targetTerminal || "default") === targetTerminal,
              )
            : null;
        const batchId =
          body.id ||
          sameUrlBatch?.id ||
          `b-${now}-${Math.random().toString(36).slice(2, 7)}`;

        const rawItems = Array.isArray(body.items) ? body.items : [];
        const globalNote = String(body.globalNote || "").trim();

        // If all items were deleted on this page, remove the batch for (url, targetTerminal)
        if (rawItems.length === 0 && !globalNote && body.action === "silent_stage") {
          const filtered = existing.filter(b => b.id !== batchId);
          writeJsonAtomic(paths.queueFile, { batches: filtered });
          sendJson(res, 200, { ok: true, removed: true });
          return;
        }

        computeAndSaveExtStatus(appHome, {
          extId: EXPECTED_EXT_ID,
          version: getBundledExtensionVersion(appHome),
          lastSeenAt: now,
        });

        let screenshotRelPath = sameUrlBatch?.screenshotRelPath || null;
        let screenshotAbsPath = sameUrlBatch?.screenshotAbsPath || null;

        if (
          typeof body.screenshotDataUrl === "string" &&
          body.screenshotDataUrl.startsWith("data:image/")
        ) {
          const commaIdx = body.screenshotDataUrl.indexOf(",");
          if (commaIdx > 0) {
            const base64 = body.screenshotDataUrl.slice(commaIdx + 1);
            const fileName = `annot-${batchId}-${now}.png`;
            screenshotAbsPath = path.join(paths.shotsDir, fileName);
            screenshotRelPath = `data/annotations/shots/${fileName}`;
            fs.writeFileSync(screenshotAbsPath, Buffer.from(base64, "base64"));
          }
        }

        const items = rawItems.map((it, idx) => ({
          id: it.id || `item-${idx + 1}`,
          index: idx + 1,
          enabled: it.enabled !== false,
          kind: it.kind || "element",
          note: String(it.note || "").trim(),
          tagName: it.tagName || "",
          selector: it.selector || "",
          text: it.text || "",
          selectedText: it.selectedText || "",
          htmlSnippet: it.htmlSnippet || "",
          rect: it.rect || null,
          styles: it.styles || {},
          source: it.source || null,
          groupedElements: Array.isArray(it.groupedElements)
            ? it.groupedElements
            : [],
        }));

        const action = body.action || "paste";
        const batch = {
          id: batchId,
          createdAt: now,
          url: body.url || "",
          title: body.title || "",
          viewport: body.viewport || null,
          globalNote,
          action,
          targetTerminal,
          targetPane: body.targetPane || null,
          screenshotRelPath,
          screenshotAbsPath,
          items,
        };

        const updated = [batch, ...existing.filter(b => b.id !== batchId)];

        while (updated.length > MAX_BATCHES) {
          const removed = updated.pop();
          if (
            removed?.screenshotAbsPath &&
            fs.existsSync(removed.screenshotAbsPath)
          ) {
            try {
              fs.unlinkSync(removed.screenshotAbsPath);
            } catch {}
          }
        }

        writeJsonAtomic(paths.queueFile, { batches: updated });

        const cmd =
          action === "silent_stage"
            ? null
            : {
                id: `cmd-${now}-${Math.random().toString(36).slice(2, 6)}`,
                batchId,
                action,
                targetTerminal: batch.targetTerminal,
                targetPane: batch.targetPane,
                createdAt: now,
              };
        if (cmd) {
          writeJsonAtomic(paths.commandFile, cmd);
        }

        sendJson(res, 200, {
          ok: true,
          batch,
          command: cmd,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/annotations/delete") {
        const body = await readRequestBody(req);
        const queue = readJsonSafe(paths.queueFile, { batches: [] });
        const batches = Array.isArray(queue.batches) ? queue.batches : [];
        if (body.batchId && body.itemId) {
          const target = batches.find(b => b.id === body.batchId);
          if (target && Array.isArray(target.items)) {
            target.items = target.items
              .filter(it => it.id !== body.itemId)
              .map((it, idx) => ({ ...it, index: idx + 1 }));
          }
          writeJsonAtomic(paths.queueFile, { batches });
        } else if (body.batchId) {
          const removed = batches.find(b => b.id === body.batchId);
          if (
            removed?.screenshotAbsPath &&
            fs.existsSync(removed.screenshotAbsPath)
          ) {
            try {
              fs.unlinkSync(removed.screenshotAbsPath);
            } catch {}
          }
          writeJsonAtomic(paths.queueFile, {
            batches: batches.filter(b => b.id !== body.batchId),
          });
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/annotations/clear") {
        let body = {};
        try {
          body = await readRequestBody(req);
        } catch {}
        const queue = readJsonSafe(paths.queueFile, { batches: [] });
        const batches = Array.isArray(queue.batches) ? queue.batches : [];
        if (body.targetTerminal) {
          const remaining = batches.filter(
            b => (b.targetTerminal || "default") !== body.targetTerminal,
          );
          writeJsonAtomic(paths.queueFile, { batches: remaining });
        } else {
          writeJsonAtomic(paths.queueFile, { batches: [] });
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });

  server.on("error", err => {
    if (err && err.code === "EADDRINUSE") {
      process.exit(0);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    writeJsonAtomic(paths.bridgeFile, {
      version: BRIDGE_VERSION,
      pid: process.pid,
      port: PORT,
      startedAt: Date.now(),
    });
  });
}

const args = parseArgs(process.argv);
if (args.mode === "daemon") {
  runDaemonBootstrap(args.appHome);
} else if (args.mode === "check-ext") {
  const res = computeAndSaveExtStatus(args.appHome);
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(0);
} else if (args.mode === "install-ext" || args.mode === "update-ext") {
  httpPostJson(`http://${HOST}:${PORT}/api/request-reload`, {}, 300).then(() =>
    installChromeExtension(args.appHome).then(res => {
      process.stdout.write(JSON.stringify(res) + "\n");
      process.exit(res.ok ? 0 : 1);
    }),
  );
} else {
  startServer(args.appHome);
}
