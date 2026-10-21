'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const APP_ID = 'com.boheyun.dashboardwidget';
const REFRESH_MS = 60 * 1000;
const CONNECTION_RETRY_BASE_MS = 5 * 1000;
const CONNECTION_RETRY_MAX_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const DESKTOP_ATTACH_TIMEOUT_MS = 20 * 1000;
const DESKTOP_RETRY_MS = 15 * 1000;
const WIDGET_SIZE = { width: 430, height: 178 };
const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const DEFAULT_CONFIG = {
  panelUrl: '',
  securePath: '',
  tokenEncrypted: '',
  placement: 'desktop',
  corner: 'bottom-right',
  positionX: null,
  positionY: null,
  panelOpacity: 0.88,
  textOpacity: 1,
  panelRadius: 17,
  opacity: 0.88,
  openAtLogin: false
};

app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let widgetWindow = null;
let settingsWindow = null;
let tray = null;
let workerProcess = null;
let refreshTimer = null;
let activeRequest = null;
let lastStats = null;
let lastError = '';
let connectionStatus = 'unconfigured';
let connectionRetryTimer = null;
let connectionRetryCount = 0;
let lastPlacementNotice = '';
let isQuitting = false;
let refreshBusy = false;
let desktopRetryTimer = null;
let desktopAttachTimer = null;
let desktopRetryCount = 0;
let desktopAttachmentAttempted = false;
let previewConfig = null;
let desktopMoveTimer = null;
let desktopMoveProcess = null;
let pendingDesktopMove = null;
let previewWindowDetached = false;

const rendererFiles = new Set([
  pathToFileURL(path.join(__dirname, '..', 'renderer', 'widget.html')).href,
  pathToFileURL(path.join(__dirname, '..', 'renderer', 'settings.html')).href
]);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeOpacity(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : fallback;
}

function readOpacityInput(value, fallback, label) {
  const candidate = value === null || value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new Error(`${label}透明度需在 0% 到 100% 之间。`);
  }
  return candidate;
}

function normalizeRadius(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 32 ? numeric : fallback;
}

function readRadiusInput(value, fallback) {
  const candidate = value === null || value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0 || candidate > 32) {
    throw new Error('圆角半径需为 0 到 32 px 的整数。');
  }
  return candidate;
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const config = { ...DEFAULT_CONFIG, ...raw };
    if (!CORNERS.has(config.corner)) config.corner = DEFAULT_CONFIG.corner;
    if (!['desktop', 'floating'].includes(config.placement)) config.placement = DEFAULT_CONFIG.placement;
    config.panelOpacity = normalizeOpacity(raw.panelOpacity ?? raw.opacity, DEFAULT_CONFIG.panelOpacity);
    config.textOpacity = normalizeOpacity(raw.textOpacity, DEFAULT_CONFIG.textOpacity);
    config.panelRadius = normalizeRadius(raw.panelRadius, DEFAULT_CONFIG.panelRadius);
    config.opacity = config.panelOpacity;
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (event.senderFrame !== event.sender.mainFrame || !rendererFiles.has(senderUrl)) {
    throw new Error('拒绝来自非应用页面的请求。');
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return callback(event, ...args);
  });
}

function writeConfig(next) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function publicConfig(config = readConfig(), { includePreview = true } = {}) {
  const effective = includePreview && previewConfig ? { ...config, ...previewConfig } : config;
  const display = getScreen().getPrimaryDisplay();
  const position = relativePosition(effective, display);
  const bounds = positionBounds(display);
  return {
    panelUrl: effective.panelUrl,
    securePath: effective.securePath,
    hasToken: Boolean(effective.tokenEncrypted),
    placement: effective.placement,
    corner: effective.corner,
    positionX: position.x,
    positionY: position.y,
    positionBounds: { xMax: bounds.xMax, yMax: bounds.yMax },
    panelOpacity: normalizeOpacity(effective.panelOpacity ?? effective.opacity, DEFAULT_CONFIG.panelOpacity),
    textOpacity: normalizeOpacity(effective.textOpacity, DEFAULT_CONFIG.textOpacity),
    panelRadius: normalizeRadius(effective.panelRadius, DEFAULT_CONFIG.panelRadius),
    opacity: normalizeOpacity(effective.panelOpacity ?? effective.opacity, DEFAULT_CONFIG.panelOpacity),
    openAtLogin: Boolean(effective.openAtLogin)
  };
}

function validateConnectionSettings(input, current) {
  const panelUrlText = String(input.panelUrl ?? '').trim().replace(/\/+$/, '');
  let panelUrl;
  try {
    panelUrl = new URL(panelUrlText);
  } catch {
    throw new Error('请填写有效的面板 HTTPS 地址。');
  }
  if (panelUrl.protocol !== 'https:' || panelUrl.username || panelUrl.password || panelUrl.search || panelUrl.hash) {
    throw new Error('面板地址必须是 HTTPS 根地址，不能包含账号、密码、查询参数或片段。');
  }
  if (panelUrl.pathname !== '/' && panelUrl.pathname !== '') {
    throw new Error('面板地址只填写域名根地址，例如 https://example.com。');
  }

  const securePath = String(input.securePath ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(securePath)) {
    throw new Error('后台安全路径需要 8–200 位字母、数字、下划线或连字符。');
  }

  const enteredToken = String(input.authorization ?? '').trim();
  let token = enteredToken || '';
  if (!token && current.tokenEncrypted) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，请重新填写管理员授权值。');
    try {
      token = safeStorage.decryptString(Buffer.from(current.tokenEncrypted, 'base64'));
    } catch {
      throw new Error('已保存的授权值无法解密，请重新填写。');
    }
  }
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
    throw new Error('请填写完整的 Authorization 授权值。');
  }
  if (!/^Bearer\s+\S+/i.test(token)) {
    throw new Error('授权值应以 “Bearer ” 开头，请复制 XBOARD_ACCESS_TOKEN 中 value 的完整内容。');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储不可用，出于安全考虑没有保存管理员授权值。');
  }

  return {
    ...current,
    panelUrl: panelUrl.origin,
    securePath,
    tokenEncrypted: enteredToken
      ? safeStorage.encryptString(token).toString('base64')
      : current.tokenEncrypted
  };
}

function validateAppearanceSettings(input, current) {
  const placement = input.placement === 'floating' ? 'floating' : 'desktop';
  const corner = CORNERS.has(input.corner)
    ? input.corner
    : (CORNERS.has(current.corner) ? current.corner : DEFAULT_CONFIG.corner);
  const display = getScreen().getPrimaryDisplay();
  const bounds = positionBounds(display);
  const fallbackPosition = relativePosition({ ...current, corner }, display);
  const positionX = clampPositionValue(input.positionX, fallbackPosition.x, bounds.xMax);
  const positionY = clampPositionValue(input.positionY, fallbackPosition.y, bounds.yMax);
  const panelOpacity = readOpacityInput(
    input.panelOpacity ?? input.opacity,
    normalizeOpacity(current.panelOpacity ?? current.opacity, DEFAULT_CONFIG.panelOpacity),
    '背景面板'
  );
  const textOpacity = readOpacityInput(
    input.textOpacity,
    normalizeOpacity(current.textOpacity, DEFAULT_CONFIG.textOpacity),
    '文字'
  );
  const panelRadius = readRadiusInput(input.panelRadius, normalizeRadius(current.panelRadius, DEFAULT_CONFIG.panelRadius));

  return {
    ...current,
    placement,
    corner,
    positionX,
    positionY,
    panelOpacity,
    textOpacity,
    panelRadius,
    opacity: panelOpacity,
    openAtLogin: input.openAtLogin === true
  };
}

function getAuthorization(config) {
  if (!config.tokenEncrypted || !safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.decryptString(Buffer.from(config.tokenEncrypted, 'base64'));
}

function apiEndpoint(config) {
  const panelUrl = new URL(config.panelUrl);
  if (panelUrl.protocol !== 'https:' || panelUrl.username || panelUrl.password || panelUrl.pathname !== '/') {
    throw new Error('面板地址无效，请在设置中重新填写 HTTPS 根地址。');
  }
  const safePath = encodeURIComponent(config.securePath);
  return new URL(`/api/v2/${safePath}/stat/getStats`, panelUrl).toString();
}

function getScreen() {
  if (!app.isReady()) throw new Error('屏幕信息暂不可用，请稍后重试。');
  return require('electron').screen;
}

function hasConnectionConfig(config) {
  return Boolean(config.panelUrl && config.securePath && config.tokenEncrypted);
}

function clearConnectionRetry() {
  if (connectionRetryTimer) clearTimeout(connectionRetryTimer);
  connectionRetryTimer = null;
}

function scheduleConnectionRetry() {
  if (isQuitting || connectionRetryTimer) return;
  const delay = Math.min(CONNECTION_RETRY_MAX_MS, CONNECTION_RETRY_BASE_MS * 2 ** Math.min(connectionRetryCount, 4));
  connectionRetryCount += 1;
  connectionRetryTimer = setTimeout(() => {
    connectionRetryTimer = null;
    void fetchStats();
  }, delay);
}

async function fetchStats({ replace = false } = {}) {
  if (isQuitting || (refreshBusy && !replace)) return;
  clearConnectionRetry();
  if (replace) {
    activeRequest?.abort();
    activeRequest = null;
    refreshBusy = false;
    lastStats = null;
    connectionRetryCount = 0;
  }
  const config = readConfig();
  if (!hasConnectionConfig(config)) {
    connectionStatus = 'unconfigured';
    lastError = '请先完成面板连接设置。';
    notifyState();
    return;
  }

  refreshBusy = true;
  // Successful minute-by-minute updates remain silent. Only initial connects
  // and recovery attempts show the connecting notice.
  if (connectionStatus !== 'connected' || replace) connectionStatus = 'connecting';
  lastError = '';
  const controller = new AbortController();
  activeRequest = controller;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  notifyState({ refreshing: true });
  try {
    const response = await fetch(apiEndpoint(config), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: getAuthorization(config),
        'Content-Language': 'zh-CN'
      }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('管理员授权已失效或没有管理员权限，请重新连接。');
      }
      throw new Error(`面板返回 HTTP ${response.status}，请检查地址和后台安全路径。`);
    }
    const payload = await response.json();
    if (payload?.status === 'fail' || payload?.success === false || (payload?.code && Number(payload.code) !== 200)) {
      throw new Error(String(payload?.message || payload?.msg || '面板拒绝了此请求。'));
    }
    let stats = payload;
    if (payload?.data?.todayIncome !== undefined) stats = payload.data;
    else if (payload?.data?.data?.todayIncome !== undefined) stats = payload.data.data;
    const values = ['todayIncome', 'ticketPendingTotal', 'commissionPendingTotal'];
    if (!stats || values.some((key) => {
      const value = stats[key];
      return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0;
    })) {
      throw new Error('接口响应格式不符合预期，请确认后台版本支持仪表盘统计接口。');
    }
    // An old request must never overwrite data after connection details change.
    if (activeRequest !== controller || isQuitting) return { ok: false, superseded: true };
    lastStats = {
      todayIncome: Number(stats.todayIncome),
      dayIncomeGrowth: Number.isFinite(Number(stats.dayIncomeGrowth)) ? Number(stats.dayIncomeGrowth) : null,
      ticketPendingTotal: Number(stats.ticketPendingTotal),
      commissionPendingTotal: Number(stats.commissionPendingTotal),
      updatedAt: Date.now()
    };
    lastError = '';
    connectionStatus = 'connected';
    connectionRetryCount = 0;
    notifyState();
    return { ok: true, stats: lastStats };
  } catch (error) {
    if (activeRequest !== controller || isQuitting) return { ok: false, superseded: true };
    lastError = error?.name === 'AbortError'
      ? '连接超时，请检查网络或面板地址。'
      : String(error?.message || '获取统计数据失败。');
    connectionStatus = 'error';
    scheduleConnectionRetry();
    notifyState();
    return { ok: false, error: lastError };
  } finally {
    clearTimeout(timer);
    if (activeRequest === controller) {
      activeRequest = null;
      refreshBusy = false;
      notifyState({ refreshing: false });
    }
  }
}

function positionBounds(display = getScreen().getPrimaryDisplay()) {
  return {
    xMax: Math.max(0, display.workArea.width - WIDGET_SIZE.width),
    yMax: Math.max(0, display.workArea.height - WIDGET_SIZE.height)
  };
}

function clampPositionValue(value, fallback, max) {
  const numeric = Number(value);
  const hasValue = value !== null && value !== undefined && value !== '';
  const candidate = hasValue && Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return Math.min(max, Math.max(0, candidate));
}

function cornerPosition(corner, display, bounds) {
  const safeCorner = CORNERS.has(corner) ? corner : DEFAULT_CONFIG.corner;
  const margin = 22;
  return {
    x: safeCorner.endsWith('right') ? Math.max(0, bounds.xMax - margin) : Math.min(bounds.xMax, margin),
    y: safeCorner.startsWith('bottom') ? Math.max(0, bounds.yMax - margin) : Math.min(bounds.yMax, margin)
  };
}

function relativePosition(config, display = getScreen().getPrimaryDisplay()) {
  const bounds = positionBounds(display);
  const fallback = cornerPosition(config.corner, display, bounds);
  return {
    x: clampPositionValue(config.positionX, fallback.x, bounds.xMax),
    y: clampPositionValue(config.positionY, fallback.y, bounds.yMax)
  };
}

function windowPlacement(config = readConfig()) {
  const display = getScreen().getPrimaryDisplay();
  const position = relativePosition(config, display);
  return {
    x: display.workArea.x + position.x,
    y: display.workArea.y + position.y
  };
}

function stopWorkerProcess({ resetRetries = true } = {}) {
  if (desktopRetryTimer) {
    clearTimeout(desktopRetryTimer);
    desktopRetryTimer = null;
  }
  if (resetRetries) desktopRetryCount = 0;
  clearTimeout(desktopAttachTimer);
  desktopAttachTimer = null;
  if (desktopMoveTimer) {
    clearTimeout(desktopMoveTimer);
    desktopMoveTimer = null;
  }
  pendingDesktopMove = null;
  if (desktopMoveProcess && !desktopMoveProcess.killed) {
    try { desktopMoveProcess.kill(); } catch { /* The move helper may already have exited. */ }
  }
  desktopMoveProcess = null;
  if (workerProcess && !workerProcess.killed) {
    try { workerProcess.kill(); } catch { /* The helper may already have exited. */ }
  }
  workerProcess = null;
}

function workerScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'workerw.ps1')
    : path.join(__dirname, 'workerw.ps1');
}

function windowHandle() {
  const hwndBuffer = widgetWindow.getNativeWindowHandle();
  return hwndBuffer.length >= 8
    ? Number(hwndBuffer.readBigUInt64LE(0))
    : hwndBuffer.readUInt32LE(0);
}

function moveDesktopWindow(position) {
  if (process.platform !== 'win32' || !widgetWindow || widgetWindow.isDestroyed()) return;
  if (desktopMoveProcess) {
    pendingDesktopMove = position;
    return;
  }
  const display = getScreen().getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', workerScriptPath(),
    '-Move',
    '-WindowHandle', String(windowHandle()),
    '-X', String(Math.round(position.x * scale)),
    '-Y', String(Math.round(position.y * scale)),
    '-Width', String(Math.round(WIDGET_SIZE.width * scale)),
    '-Height', String(Math.round(WIDGET_SIZE.height * scale))
  ];
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
  desktopMoveProcess = child;
  const complete = () => {
    if (desktopMoveProcess !== child) return;
    desktopMoveProcess = null;
    const next = pendingDesktopMove;
    pendingDesktopMove = null;
    if (next) moveDesktopWindow(next);
  };
  child.once('error', complete);
  child.once('exit', complete);
}

function scheduleDesktopMove(position) {
  if (desktopMoveTimer) clearTimeout(desktopMoveTimer);
  desktopMoveTimer = setTimeout(() => {
    desktopMoveTimer = null;
    moveDesktopWindow(position);
  }, 35);
}

function applyPreview() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const config = { ...readConfig(), ...(previewConfig || {}) };
  const position = windowPlacement(config);
  widgetWindow.setOpacity(1);
  // Preview is temporary and must stay visible while the settings window is
  // focused. The normal desktop/floating z-order is restored by clearPreview.
  widgetWindow.setAlwaysOnTop(true);
  if (config.placement === 'desktop' && process.platform === 'win32') {
    if (!previewWindowDetached) {
      stopWorkerProcess();
      detachWindowFromDesktop();
      previewWindowDetached = true;
    }
    // The desktop child sits behind the settings window, so temporarily show
    // it as a topmost preview while the user adjusts sliders. Save/cancel or
    // closing settings restores the configured desktop placement.
  }
  widgetWindow.setBounds({ ...position, ...WIDGET_SIZE });
  widgetWindow.showInactive();
  // Keep the visual preview on its own channel so renderer CSS updates are
  // not delayed by a full statistics state refresh.
  notifyPreview();
  notifyState({ preview: true });
}

function clearPreview({ restore = true } = {}) {
  const hadPreview = Boolean(previewConfig || previewWindowDetached);
  previewConfig = null;
  previewWindowDetached = false;
  pendingDesktopMove = null;
  if (desktopMoveTimer) {
    clearTimeout(desktopMoveTimer);
    desktopMoveTimer = null;
  }
  if (desktopMoveProcess && !desktopMoveProcess.killed) {
    try { desktopMoveProcess.kill(); } catch { /* The move helper may already have exited. */ }
  }
  desktopMoveProcess = null;
  if (restore && hadPreview && widgetWindow && !widgetWindow.isDestroyed()) {
    applyWindowMode(readConfig().placement);
    notifyState({ previewReset: true });
  }
}

function killWorkerProcess() {
  stopWorkerProcess({ resetRetries: true });
}

function retryDesktopPlacement(message) {
  if (isQuitting || previewConfig || readConfig().placement !== 'desktop' || !widgetWindow || widgetWindow.isDestroyed()) return;
  if (desktopRetryTimer) return;
  showDesktopFallback(message);
  let retryDelay = 1500;
  if (desktopRetryCount >= 3) {
    retryDelay = DESKTOP_RETRY_MS;
  }
  desktopRetryCount += 1;
  desktopRetryTimer = setTimeout(() => {
    desktopRetryTimer = null;
    if (!isQuitting && !previewConfig && readConfig().placement === 'desktop' && widgetWindow && !widgetWindow.isDestroyed()) {
      applyWindowMode('desktop', { retrying: true });
    }
  }, retryDelay);
}

function createTrayIcon() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect x="1" y="1" width="14" height="14" rx="4" fill="#17312b" stroke="#8ae2bb"/>
  <path d="M4 11V8.1M8 11V5M12 11V6.9" stroke="#a7f0cf" stroke-width="1.7" stroke-linecap="round"/>
</svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Xboard面板桌面仪表盘');
  const menu = Menu.buildFromTemplate([
    { label: '打开设置窗口', click: () => openSettings() },
    { label: '刷新数据', click: () => { void fetchStats(); } },
    { type: 'separator' },
    { label: '退出程序', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => openSettings());
}

function detachWindowFromDesktop() {
  if (!desktopAttachmentAttempted || !widgetWindow || widgetWindow.isDestroyed() || process.platform !== 'win32') return true;
  const psScript = app.isPackaged
    ? path.join(process.resourcesPath, 'workerw.ps1')
    : path.join(__dirname, 'workerw.ps1');
  const hwndBuffer = widgetWindow.getNativeWindowHandle();
  const hwnd = hwndBuffer.length >= 8
    ? Number(hwndBuffer.readBigUInt64LE(0))
    : hwndBuffer.readUInt32LE(0);
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', psScript,
    '-Detach',
    '-WindowHandle', String(hwnd)
  ], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  const detached = !result.error && result.status === 0;
  if (detached) desktopAttachmentAttempted = false;
  return detached;
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(fetchStats, REFRESH_MS);
}

function lockWindowNavigation(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

function applyWindowMode(mode = readConfig().placement, { retrying = false, configOverride = null } = {}) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  // Replacing the helper is part of a retry; keep the retry counter so a
  // transient Explorer transition cannot retry forever.
  stopWorkerProcess({ resetRetries: false });
  detachWindowFromDesktop();
  const config = configOverride || readConfig();
  widgetWindow.setAlwaysOnTop(mode !== 'desktop');
  widgetWindow.setOpacity(1);
  const pos = windowPlacement(config);
  widgetWindow.setBounds({ ...pos, ...WIDGET_SIZE });
  // Keep Electron's visibility/compositor state in sync with the native HWND.
  // Native ShowWindow after BrowserWindow.hide() alone can leave a blank widget.
  widgetWindow.showInactive();
  if (mode !== 'desktop' || process.platform !== 'win32') {
    desktopRetryCount = 0;
    lastPlacementNotice = '';
    notifyState();
    return;
  }

  const display = getScreen().getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const [x, y] = widgetWindow.getPosition();
  const psScript = workerScriptPath();
  const hwnd = windowHandle();
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', psScript,
    '-WindowHandle', String(hwnd),
    '-X', String(Math.round(x * scale)),
    '-Y', String(Math.round(y * scale)),
    '-Width', String(Math.round(WIDGET_SIZE.width * scale)),
    '-Height', String(Math.round(WIDGET_SIZE.height * scale))
  ];
  desktopAttachmentAttempted = true;
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  workerProcess = child;
  if (!retrying) desktopRetryCount = 0;
  let output = '';
  let childAttached = false;
  child.stdout.on('data', (chunk) => {
    if (workerProcess !== child || isQuitting) return;
    output += chunk.toString();
    if (!output.includes('ATTACHED')) return;
    output = '';
    childAttached = true;
    desktopAttachmentAttempted = true;
    clearTimeout(desktopAttachTimer);
    desktopAttachTimer = null;
    desktopRetryCount = 0;
    lastPlacementNotice = '';
    notifyState();
  });
  desktopAttachTimer = setTimeout(() => {
    if (workerProcess !== child || isQuitting) return;
    stopWorkerProcess({ resetRetries: false });
    desktopAttachmentAttempted = false;
    retryDesktopPlacement('桌面层暂未就绪，组件已显示，将自动重试。');
  }, DESKTOP_ATTACH_TIMEOUT_MS);
  child.on('error', () => {
    if (workerProcess !== child) return;
    workerProcess = null;
    clearTimeout(desktopAttachTimer);
    desktopAttachTimer = null;
    retryDesktopPlacement('桌面层暂未就绪，组件已显示，将自动重试。');
  });
  child.on('exit', (code) => {
    if (workerProcess !== child) return;
    workerProcess = null;
    clearTimeout(desktopAttachTimer);
    desktopAttachTimer = null;
    if (!isQuitting && readConfig().placement === 'desktop' && widgetWindow && !widgetWindow.isDestroyed()) {
      retryDesktopPlacement(code === 0
        ? '桌面层连接中断，组件已显示，将自动重试。'
        : '桌面层暂未就绪，组件已显示，将自动重试。');
    }
  });
}

function showDesktopFallback(message) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    detachWindowFromDesktop();
    widgetWindow.setAlwaysOnTop(false);
    widgetWindow.setBounds({ ...windowPlacement(), ...WIDGET_SIZE });
    widgetWindow.showInactive();
  }
  lastPlacementNotice = message;
  notifyState();
}

function statePayload(extra = {}) {
  return {
    stats: lastStats,
    error: lastError,
    connectionStatus,
    placementNotice: lastPlacementNotice,
    refreshing: refreshBusy,
    updatedAt: lastStats?.updatedAt || null,
    config: publicConfig(),
    ...extra
  };
}

function notifyState(extra = {}) {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget:state', statePayload(extra));
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:state', statePayload(extra));
}

function notifyPreview() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('widget:preview', publicConfig());
  }
}

function createWidget() {
  const config = readConfig();
  const pos = windowPlacement(config);
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setBounds({ ...pos, ...WIDGET_SIZE });
    applyWindowMode(config.placement);
    notifyState();
    return;
  }
  widgetWindow = new BrowserWindow({
    ...pos,
    ...WIDGET_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: config.placement !== 'desktop',
    opacity: 1,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  });
  widgetWindow.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'));
  lockWindowNavigation(widgetWindow);
  widgetWindow.once('ready-to-show', () => {
    widgetWindow.showInactive();
    void fetchStats();
    applyWindowMode(readConfig().placement);
  });
  widgetWindow.on('closed', () => {
    widgetWindow = null;
    killWorkerProcess();
    desktopAttachmentAttempted = false;
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    notifyState({ settingsOpened: true });
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 680,
    height: 820,
    minWidth: 580,
    minHeight: 600,
    title: 'Xboard面板桌面仪表盘 · 设置',
    backgroundColor: '#f2f5f2',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  lockWindowNavigation(settingsWindow);
  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
    notifyState({ settingsOpened: true });
  });
  settingsWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      clearPreview();
      settingsWindow?.hide();
    }
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function setupLoginItem(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
}

handle('widget:get-state', () => statePayload());
handle('widget:refresh', () => fetchStats());
handle('widget:open-settings', () => { openSettings(); return true; });
handle('widget:quit', () => { isQuitting = true; app.quit(); return true; });
handle('settings:get', () => publicConfig());
handle('settings:preview', (_event, input = {}) => {
  const current = readConfig();
  const display = getScreen().getPrimaryDisplay();
  const bounds = positionBounds(display);
  const fallback = relativePosition(current, display);
  previewConfig = {
    positionX: clampPositionValue(input.positionX, fallback.x, bounds.xMax),
    positionY: clampPositionValue(input.positionY, fallback.y, bounds.yMax),
    panelOpacity: readOpacityInput(
      input.panelOpacity,
      normalizeOpacity(current.panelOpacity ?? current.opacity, DEFAULT_CONFIG.panelOpacity),
      '背景面板'
    ),
    textOpacity: readOpacityInput(
      input.textOpacity,
      normalizeOpacity(current.textOpacity, DEFAULT_CONFIG.textOpacity),
      '文字'
    ),
    panelRadius: readRadiusInput(
      input.panelRadius,
      normalizeRadius(current.panelRadius, DEFAULT_CONFIG.panelRadius)
    )
  };
  applyPreview();
  return { ok: true, config: publicConfig(current) };
});
handle('settings:save', (_event, input) => {
  const current = readConfig();
  const updated = validateAppearanceSettings(input || {}, current);
  writeConfig(updated);
  setupLoginItem(updated.openAtLogin);
  if (!widgetWindow || widgetWindow.isDestroyed()) createWidget();
  else {
    const restorePlacement = previewWindowDetached || current.placement !== updated.placement ||
      current.positionX !== updated.positionX || current.positionY !== updated.positionY;
    clearPreview({ restore: false });
    if (restorePlacement) applyWindowMode(updated.placement);
    notifyPreview();
  }
  notifyState({ saved: true });
  return { ok: true, config: publicConfig(updated, { includePreview: false }) };
});
handle('settings:save-connection', (_event, input) => {
  const updated = validateConnectionSettings(input || {}, readConfig());
  writeConfig(updated);
  startRefreshTimer();
  // Persist immediately; the widget reports progress independently of settings.
  if (!widgetWindow || widgetWindow.isDestroyed()) createWidget();
  else void fetchStats({ replace: true });
  return { ok: true, config: publicConfig(updated, { includePreview: false }) };
});
handle('settings:open-dashboard', async () => {
  const config = readConfig();
  if (!config.panelUrl) return false;
  const panelUrl = new URL(config.panelUrl);
  if (panelUrl.protocol !== 'https:' || panelUrl.username || panelUrl.password) return false;
  const { shell } = require('electron');
  await shell.openExternal(panelUrl.origin);
  return true;
});
handle('settings:cancel', () => {
  clearPreview();
  settingsWindow?.hide();
  return true;
});

app.on('second-instance', () => {
  openSettings();
});

app.whenReady().then(() => {
  if (!singleInstance) return;
  createTray();
  getScreen().on('display-metrics-changed', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) applyWindowMode(readConfig().placement);
    notifyState();
  });
  const config = readConfig();
  connectionStatus = hasConnectionConfig(config) ? 'connecting' : 'unconfigured';
  setupLoginItem(Boolean(config.openAtLogin));
  createWidget();
  startRefreshTimer();
  if (hasConnectionConfig(config)) {
    openSettingsIfRequested();
  } else {
    openSettings();
  }
});

function openSettingsIfRequested() {
  if (process.argv.includes('--settings')) openSettings();
}

app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(refreshTimer);
  clearConnectionRetry();
  if (desktopRetryTimer) clearTimeout(desktopRetryTimer);
  desktopRetryTimer = null;
  activeRequest?.abort();
  // Restore the native window before the helper exits so Explorer never keeps
  // a stale child window attached to the desktop host.
  detachWindowFromDesktop();
  killWorkerProcess();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !isQuitting) app.quit();
});
