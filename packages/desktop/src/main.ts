import type { Server } from "node:http";
import { join } from "node:path";
import { type RefreshResult, refreshCheckout, startDashboard } from "@homeostat/dashboard";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import {
  checkKb,
  cloneKb,
  gitPath,
  type KbCheck,
  readPrefs,
  setupPage,
  windowTitle,
  writePrefs,
} from "./kb.ts";

/**
 * The homeostat dashboard as a desktop app. It runs the same local server as
 * `homeostat dashboard` against the developer's own KB checkout, and keeps that checkout current
 * from origin when the app opens, when its window comes to the front, and on Refresh (or every
 * minute while open, if turned on). Nothing runs when the app is closed, and it never pushes.
 */

process.env.PATH = gitPath(process.env);
const FOCUS_REFRESH_MS = 30_000;
const LIVE_REFRESH_MS = 60_000;

const prefsFile = () => join(app.getPath("userData"), "prefs.json");
let win: BrowserWindow | undefined;
let server: Server | undefined;
let origin = "";
let kb: Extract<KbCheck, { ok: true }> | undefined;
let lastRefresh = 0;
let liveTimer: NodeJS.Timeout | undefined;
let refreshing: Promise<RefreshResult | undefined> | undefined;

const external = (url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
};

/** Fetches, then redraws if anything moved, unless a settings form is open mid-edit. */
function refresh(reload: "if-changed" | "always" | "never"): Promise<RefreshResult | undefined> {
  if (!kb || !win) return Promise.resolve(undefined);
  if (refreshing) return refreshing;
  const shown = kb;
  lastRefresh = Date.now();
  refreshing = refreshCheckout(shown.root, shown.base)
    .then((r) => {
      if (!win || kb !== shown) return r;
      win.setTitle(windowTitle(shown.name, r, new Date()));
      const editing = (() => {
        try {
          return new URL(win.webContents.getURL()).pathname.startsWith("/settings/");
        } catch {
          return false;
        }
      })();
      if (reload === "always" || (reload === "if-changed" && r.changed && !editing))
        win.webContents.reload();
      return r;
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

function setLive(on: boolean) {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = on ? setInterval(() => void refresh("if-changed"), LIVE_REFRESH_MS) : undefined;
  writePrefs(prefsFile(), { ...readPrefs(prefsFile()), live: on });
}

async function showSetup(error?: string) {
  kb = undefined;
  win?.setTitle("Homeostat");
  await win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(setupPage(error))}`);
}

/** Shows a KB checkout: brings it up to date, then serves its dashboard on a free local port. */
async function open(dir: string): Promise<{ error?: string }> {
  const check = checkKb(dir);
  if (!check.ok) return { error: check.error };
  kb = check;
  writePrefs(prefsFile(), { ...readPrefs(prefsFile()), kbDir: check.root });
  win?.setTitle(`Homeostat · ${check.name} · updating…`);
  await refresh("never");
  server?.close();
  const started = await startDashboard({ kbRoot: check.root, port: 0 });
  server = started.server;
  origin = new URL(started.url).origin;
  await win?.loadURL(started.url);
  buildMenu();
  return {};
}

async function chooseFolder(): Promise<{ error?: string }> {
  if (!win) return {};
  const picked = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    message: "Choose your team's knowledge base checkout (the folder with homeostat.yaml)",
  });
  const dir = picked.filePaths[0];
  return picked.canceled || !dir ? {} : open(dir);
}

/** Only the first-run page may ask; the dashboard's own pages never can. */
const fromSetup = (e: IpcMainInvokeEvent) => e.senderFrame?.url.startsWith("data:") === true;

ipcMain.handle("kb:choose", (e) => (fromSetup(e) ? chooseFolder() : {}));
ipcMain.handle("kb:clone", async (e, url: string) => {
  if (!fromSetup(e)) return {};
  const cloned = await cloneKb(String(url), join(app.getPath("documents"), "Homeostat"));
  return "error" in cloned ? cloned : open(cloned.dir);
});

function buildMenu() {
  const live = readPrefs(prefsFile()).live === true;
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Open Knowledge Base…",
          accelerator: "CmdOrCtrl+O",
          click: () => void chooseFolder(),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh",
          accelerator: "CmdOrCtrl+R",
          enabled: kb !== undefined,
          click: () => void refresh("always"),
        },
        {
          label: "Refresh Every Minute While Open",
          type: "checkbox",
          checked: live,
          click: (item) => setLive(item.checked),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as const]),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    title: "Homeostat",
    backgroundColor: "#0b0d12",
    show: !smoke,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
  });
  // The window shows the local dashboard and the first-run page; anything else opens in the browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("data:") || (origin && url.startsWith(`${origin}/`))) return;
    e.preventDefault();
    external(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.on("focus", () => {
    if (Date.now() - lastRefresh > FOCUS_REFRESH_MS) void refresh("if-changed");
  });
  win.on("closed", () => {
    win = undefined;
  });
}

/** `--smoke <dir>`: open a KB without showing a window, print what loaded, and quit. For CI. */
const smokeAt = process.argv.indexOf("--smoke");
const smoke = smokeAt > 0 ? (process.argv[smokeAt + 1] ?? "") : undefined;

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => server?.close());

app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  if (smoke !== undefined) {
    const timeout = setTimeout(() => app.exit(2), 60_000);
    const r = await open(smoke);
    const title = r.error ? "" : await win?.webContents.executeJavaScript("document.title");
    process.stdout.write(`${JSON.stringify({ error: r.error, title, origin })}\n`);
    clearTimeout(timeout);
    app.exit(r.error ? 1 : 0);
    return;
  }
  const prefs = readPrefs(prefsFile());
  if (prefs.live) setLive(true);
  const dir = prefs.kbDir ?? process.env.HOMEOSTAT_DIR;
  const r = dir ? await open(dir) : { error: undefined };
  if (!kb) await showSetup(r.error);
});
