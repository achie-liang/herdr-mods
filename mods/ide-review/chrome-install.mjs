// Local CLI only. No HTTP route, startup hook or browser message can call this.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
const EXT_ID = 'gmgfppipckmjcfgfhlcokjpjmmobbopn';
export function chromeRegistration(extensionDir, browserRoot = path.join(os.homedir(), 'Library/Application Support/Google/Chrome')) {
  let profiles;
  try { profiles = fs.readdirSync(browserRoot).filter(n => n === 'Default' || /^Profile \d+$/.test(n)); } catch { return null; }
  for (const profile of profiles) {
    for (const name of ['Secure Preferences', 'Preferences']) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(browserRoot, profile, name), 'utf8'));
        const info = data.extensions?.settings?.[EXT_ID];
        if (info && info.path === extensionDir && info.state !== 0) return { version: info.manifest?.version || null };
      } catch {}
    }
  }
  return null;
}
const APPLESCRIPT = `
on findButton(el, wanted, depth)
  if depth > 12 then return missing value
  tell application "System Events"
    try
      if role of el is "AXButton" then
        set n to name of el as text
        if wanted is "load" and (n contains "Load unpacked" or n contains "加载已解压" or n contains "加载未打包") then return el
        if wanted is "reload" and (n is "Reload" or n is "重新加载") then return el
      end if
      repeat with c in UI elements of el
        set b to my findButton(contents of c, wanted, depth + 1)
        if b is not missing value then return b
      end repeat
    end try
  end tell
  return missing value
end findButton
on enableDeveloperMode(el, depth)
  if depth > 12 then return
  tell application "System Events"
    try
      if role of el is "AXCheckBox" then
        set n to name of el as text
        if (n contains "Developer mode" or n contains "开发者模式") and value of el is 0 then click el
      end if
      repeat with c in UI elements of el
        my enableDeveloperMode(contents of c, depth + 1)
      end repeat
    end try
  end tell
end enableDeveloperMode
on findHerdrCard(el, depth)
  if depth > 12 then return missing value
  tell application "System Events"
    try
      -- Only a card that directly names our extension may supply a reload button.
      repeat with c in UI elements of el
        if role of c is "AXStaticText" and name of c as text is "Herdr UI Review" then return el
      end repeat
      repeat with c in UI elements of el
        set card to my findHerdrCard(contents of c, depth + 1)
        if card is not missing value then return card
      end repeat
    end try
  end tell
  return missing value
end findHerdrCard
on run argv
  set mode to item 1 of argv
  set extPath to item 2 of argv
  tell application "Google Chrome"
    activate
    if (count of windows) is 0 then make new window
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
    if not foundTab then tell w to make new tab at end of tabs with properties {URL:"chrome://extensions/"}
  end tell
  delay 0.8
  tell application "System Events"
    tell process "Google Chrome"
      set frontmost to true
      try
        set value of attribute "AXEnhancedUserInterface" to true
      end try
      set win to window 1
      if mode is "reload" then
        set card to my findHerdrCard(win, 0)
        if card is missing value then return "ASSISTED"
        set reloadButton to my findButton(card, "reload", 0)
        if reloadButton is missing value then return "ASSISTED"
        click reloadButton
        return "RELOAD_REQUESTED"
      end if
      -- Enable developer mode only for this explicit user-initiated install.
      my enableDeveloperMode(win, 0)
      delay 0.4
      set loadButton to my findButton(win, "load", 0)
      if loadButton is missing value then return "ASSISTED"
      click loadButton
      delay 0.7
      if (count of sheets of win) is 0 then return "ASSISTED"
      keystroke "g" using {command down, shift down}
      delay 0.5
      set the clipboard to extPath
      keystroke "v" using {command down}
      key code 36
      delay 0.6
      key code 36
      return "INSTALL_REQUESTED"
    end tell
  end tell
end run
`;
const runner = (cmd, args, options = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 15000, ...options }, (error, stdout, stderr) => resolve({
    ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(),
  }));
});
// macOS blocks synthetic UI control without consent; each denial needs a different pane.
export function permissionProblem(result) {
  const detail = `${result?.stderr || ''} ${result?.stdout || ''}`;
  if (/-1719|assistive access|辅助访问/i.test(detail)) return {
    mode: 'permission',
    message: 'Chrome 自动化被系统阻止：请在「系统设置 › 隐私与安全性 › 辅助功能」中勾选运行 Herdr 的程序（Herdr 或 osascript），然后重试。也可在 chrome://extensions 手动加载插件。',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  };
  if (/-1743|not authorized to send apple events|不允许发送 Apple 事件/i.test(detail)) return {
    mode: 'permission',
    message: 'Herdr 没有控制浏览器的权限：请在「系统设置 › 隐私与安全性 › 自动化」中允许控制 Google Chrome，然后重试。',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  };
  return null;
}
export async function installChromeExtension(appHome, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || runner;
  const registration = options.registration || chromeRegistration;
  const extensionDir = path.join(appHome, 'mods/ide-review/chrome-extension');
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('Extension folder is missing');
  if (platform !== 'darwin') return { ok: true, mode: 'assisted', message: '此平台请在 chrome://extensions 手动加载插件目录', extensionDir };
  const before = registration(extensionDir);
  const mode = before ? 'reload' : 'install';
  const result = await run('osascript', ['-e', APPLESCRIPT, mode, extensionDir]);
  const denied = result.ok ? null : permissionProblem(result);
  if (denied) return { ok: false, ...denied, extensionDir };
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (result.ok && ['RELOAD_REQUESTED', 'INSTALL_REQUESTED'].includes(result.stdout)) await wait(900);
  const after = registration(extensionDir);
  const bundled = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')).version;
  if (result.ok && after?.version === bundled && ['RELOAD_REQUESTED', 'INSTALL_REQUESTED'].includes(result.stdout)) {
    return { ok: true, mode: 'auto', message: mode === 'reload' ? '已请求 Chrome 重新加载 Herdr 插件' : 'Chrome 已登记 Herdr 插件', extensionDir };
  }
  await run('open', ['-R', extensionDir]);
  return { ok: true, mode: 'assisted', message: '已打开 Chrome 扩展中心。开启开发者模式并加载此目录；若已安装，点击 Herdr UI Review 的重新加载。自动操作可能需要辅助功能权限。', extensionDir };
}
