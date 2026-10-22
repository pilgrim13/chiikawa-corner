const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, clipboard, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createUpdater, acknowledgeUpdate } = require('./updater.cjs');

const testMode = process.env.CORNER_TEST === '1';
if (testMode && /^\d{2,5}$/.test(process.env.CORNER_TEST_DEBUG_PORT || '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CORNER_TEST_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
if (process.env.CORNER_USER_DATA) app.setPath('userData', process.env.CORNER_USER_DATA);
app.setName('치이카와 모퉁이');
const config = require('./config.json');
const serverUrl = process.env.CORNER_SERVER_URL || config.serverUrl;
let panel, overlay, tray, localRelay, updater;
let quitting = false;
let overlayVisible = true;
let overlayState = { room: null, memberId: null, size: 1, quiet: false };
let selectedDisplayId;
const settingsFile = path.join(app.getPath('userData'), 'window-settings.json');
try { selectedDisplayId = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).displayId; } catch {}

if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(start).catch((error) => { console.error('App startup failed:', error.message); app.quit(); });
}

function selectedDisplay() {
  return screen.getAllDisplays().find((d) => d.id === selectedDisplayId) || screen.getPrimaryDisplay();
}
function positionOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(selectedDisplay().workArea);
}
function webPreferences() {
  return { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
}
function protectWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.CORNER_DEV_URL ? url.startsWith(process.env.CORNER_DEV_URL) : url.startsWith(pathToFileURL(path.join(__dirname, '../dist/index.html')).href);
    if (!allowed) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}
function loadView(window, view) {
  if (process.env.CORNER_DEV_URL) return window.loadURL(`${process.env.CORNER_DEV_URL}/?view=${view}`);
  return window.loadFile(path.join(__dirname, '../dist/index.html'), { query: { view } });
}
function showPanel() {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.focus();
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '모퉁이 열기', click: showPanel },
    { label: overlayVisible ? '캐릭터 잠깐 숨기기' : '캐릭터 다시 보기', click: toggleOverlay },
    { type: 'separator' },
    { label: '입력창 열기: ⌘⇧Space', enabled: false },
    { label: '완전히 종료', click: () => app.quit() },
  ]));
}
function toggleOverlay() {
  overlayVisible = !overlayVisible;
  if (overlayVisible && overlayState.room) overlay.showInactive(); else overlay.hide();
  updateTray();
  return overlayVisible;
}
async function ensureLocalRelay() {
  const endpoint = new URL(serverUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) return;
  try {
    const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1200) });
    if (response.ok) return;
  } catch {}
  try {
    const { createRoomServer } = await import(pathToFileURL(path.join(__dirname, '../server/index.mjs')).href);
    localRelay = createRoomServer();
    await localRelay.listen(Number(endpoint.port || 47831), '127.0.0.1');
  } catch (error) {
    console.error('Local relay unavailable:', error.message);
  }
}
async function start() {
  const updateConfig = testMode && process.env.CORNER_UPDATE_CONFIG ? JSON.parse(fs.readFileSync(process.env.CORNER_UPDATE_CONFIG, 'utf8')) : require('./update-config.json');
  updater = createUpdater({ app, config: updateConfig, testMode, onState: (state) => { if (panel && !panel.isDestroyed()) panel.webContents.send('corner:update-state', state); } });
  await ensureLocalRelay();
  const area = selectedDisplay().workArea;
  panel = new BrowserWindow({
    width: Math.min(1000, area.width - 40), height: Math.min(780, area.height - 40), minWidth: 680, minHeight: 560,
    title: '치이카와 모퉁이', backgroundColor: '#fffaf1', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 21 },
    webPreferences: webPreferences(),
  });
  overlay = new BrowserWindow({
    ...area, transparent: true, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, focusable: false, show: false,
    alwaysOnTop: true, fullscreenable: false,
    webPreferences: { ...webPreferences(), backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  protectWindow(panel); protectWindow(overlay);
  panel.once('ready-to-show', () => { if (process.env.CORNER_HEADLESS !== '1') showPanel(); });
  panel.on('close', (event) => { if (!quitting && !testMode) { event.preventDefault(); panel.hide(); } });
  overlay.on('closed', () => { overlay = null; });
  screen.on('display-added', positionOverlay);
  screen.on('display-removed', positionOverlay);
  screen.on('display-metrics-changed', positionOverlay);
  await Promise.all([loadView(panel, 'panel'), loadView(overlay, 'overlay')]);
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '../dist/characters/chiikawa.png')).resize({ width: 22, height: 22 });
  tray = new Tray(trayIcon);
  tray.setToolTip('치이카와 모퉁이');
  tray.on('click', showPanel);
  updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: '모퉁이 열기', click: showPanel }, { role: 'hide' }, { role: 'quit' }] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ label: '캐릭터 숨기기 / 보기', click: toggleOverlay }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  if (!testMode) globalShortcut.register('CommandOrControl+Shift+Space', () => panel.isVisible() && panel.isFocused() ? panel.hide() : showPanel());
  // Confirm the local UI rendered and its IPC bridge is ready before removing the old bundle.
  if (process.env.CORNER_UPDATE_TOKEN) {
    for (let i = 0; i < 100; i++) {
      if (await panel.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell') && window.corner)").catch(() => false)) { acknowledgeUpdate(app); break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
function fromPanel(event) { return panel && event.sender === panel.webContents; }
function fromOwnWindow(event) { return fromPanel(event) || (overlay && event.sender === overlay.webContents); }
ipcMain.handle('corner:config', () => ({ serverUrl, version: app.getVersion(), isDesktop: true }));
ipcMain.handle('corner:update-state', (event) => fromPanel(event) ? updater.getState() : null);
ipcMain.handle('corner:update-check', (event) => fromPanel(event) ? updater.check() : null);
ipcMain.handle('corner:update-download', (event) => fromPanel(event) ? updater.download() : null);
ipcMain.handle('corner:update-install', (event) => fromPanel(event) ? updater.install() : null);
ipcMain.handle('corner:overlay-current', () => overlayState);
ipcMain.on('corner:overlay-state', (event, state) => {
  if (!fromPanel(event) || !state || !('room' in state)) return;
  overlayState = state;
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('corner:overlay-state', state);
    if (state.room && overlayVisible) overlay.showInactive(); else overlay.hide();
  }
});
ipcMain.on('corner:mouse-passthrough', (event, ignore) => {
  if (overlay && event.sender === overlay.webContents) overlay.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
ipcMain.on('corner:open-panel', (event) => { if (fromOwnWindow(event)) showPanel(); });
ipcMain.on('corner:hide-panel', (event) => { if (fromPanel(event)) panel.hide(); });
ipcMain.handle('corner:toggle-overlay', (event) => fromPanel(event) ? toggleOverlay() : false);
ipcMain.handle('corner:copy', (event, text) => { if (fromPanel(event) && typeof text === 'string' && text.length < 10000) clipboard.writeText(text); });
ipcMain.handle('corner:displays', () => screen.getAllDisplays().map((display, i) => ({ id: display.id, label: display.label || `모니터 ${i + 1}` })));
ipcMain.handle('corner:select-display', (event, id) => {
  if (!fromPanel(event) || !screen.getAllDisplays().some((d) => d.id === id)) return;
  selectedDisplayId = id;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ displayId: id }));
  positionOverlay();
});
app.on('activate', showPanel);
app.on('window-all-closed', () => { if (testMode) app.quit(); });
app.on('before-quit', () => { quitting = true; globalShortcut.unregisterAll(); if (localRelay) localRelay.close(); });
