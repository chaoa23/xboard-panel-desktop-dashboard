const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const EventEmitter = require('node:events');

const MAIN_FILE = path.join(__dirname, '..', 'electron', 'main.js');
const SOURCE = fs.readFileSync(MAIN_FILE, 'utf8') + `
globalThis.__mainTestExports = {
  createWidget, fetchStats, applyWindowMode, statePayload, readConfig, writeConfig,
  getAuthorization, hasConnectionConfig
};
`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness({ config = null, fetchImpl = null } = {}) {
  const events = [];
  const handlers = new Map();
  const timers = new Map();
  const files = new Map();
  const children = [];
  let nextTimerId = 1;
  let readyResolve;
  let now = 0;
  let decryptCalls = 0;
  let fetchCalls = 0;

  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise((resolve) => { readyResolve = resolve; }),
    isReady: () => true,
    getPath: () => 'C:\\fake-user-data',
    getName: () => 'test',
    getVersion: () => '1.0.0',
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
    quit: () => events.push('app:quit'),
    exit: () => events.push('app:exit')
  });

  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    })
  });

  class FakeBrowserWindow extends EventEmitter {
    static all = [];
    constructor(options) {
      super();
      this.options = options;
      this.webContents = {
        sent: [],
        send: (channel, value) => this.webContents.sent.push({ channel, value }),
        setWindowOpenHandler: () => {},
        on: () => {}
      };
      this.destroyed = false;
      this.visible = Boolean(options.show);
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.alwaysOnTop = Boolean(options.alwaysOnTop);
      this.opacity = options.opacity;
      this.nativeHandle = Buffer.alloc(8);
      FakeBrowserWindow.all.push(this);
    }
    loadFile(file) { this.loadedFile = file; }
    showInactive() { this.visible = true; events.push('window:showInactive'); }
    show() { this.visible = true; events.push('window:show'); }
    hide() { this.visible = false; events.push('window:hide'); }
    focus() { events.push('window:focus'); }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; }
    setOpacity(value) { this.opacity = value; }
    setBounds(value) { this.bounds = value; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    getNativeWindowHandle() { return this.nativeHandle; }
    close() { this.emit('close', { preventDefault() {} }); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  FakeBrowserWindow.getAllWindows = () => FakeBrowserWindow.all.filter((window) => !window.destroyed);

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.killed = false;
      this.exitCode = null;
    }
    kill() { this.killed = true; }
  }

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    Menu: { buildFromTemplate: () => ({}) },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} },
    nativeImage: { createFromDataURL: () => ({}) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => { decryptCalls += 1; return value.toString().replace(/^encrypted:/, ''); }
    },
    screen
  };

  const fakeFs = {
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    mkdirSync: () => {},
    writeFileSync: (file, value) => files.set(file, String(value)),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); }
  };
  const fakeChildProcess = {
    spawn: () => { const child = new FakeChild(); children.push(child); return child; },
    spawnSync: () => ({ status: 0, error: null })
  };

  const timeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, at: now + delay, interval: 0 });
    return id;
  };
  const interval = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, at: now + delay, interval: delay });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    now = target;
    await flush();
  };

  const calls = [];
  const fakeFetch = async (...args) => {
    fetchCalls += 1;
    calls.push(args);
    if (fetchImpl) return fetchImpl(fetchCalls, ...args);
    return { ok: true, json: async () => ({ todayIncome: 1, ticketPendingTotal: 2, commissionPendingTotal: 3 }) };
  };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    Promise,
    Date: class extends Date { static now = () => now; },
    setTimeout: timeout,
    clearTimeout: clearTimer,
    setInterval: interval,
    clearInterval: clearTimer,
    fetch: fakeFetch,
    process: { ...process, argv: ['node', MAIN_FILE], platform: 'win32' },
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:url') return require('node:url');
      if (name === 'node:child_process') return fakeChildProcess;
      throw new Error(`unexpected require: ${name}`);
    },
    __dirname: path.dirname(MAIN_FILE),
    __filename: MAIN_FILE,
    globalThis: undefined
  });
  context.globalThis = context;

  const configFile = path.join('C:\\fake-user-data', 'settings.json');
  if (config) files.set(configFile, JSON.stringify(config));
  vm.runInContext(SOURCE, context, { filename: MAIN_FILE });

  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const boot = async () => {
    readyResolve();
    await flush();
    return FakeBrowserWindow.all[0];
  };
  const event = () => ({
    sender: { mainFrame: {} },
    senderFrame: null
  });
  const invoke = async (channel, ...args) => {
    const frame = { url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'settings.html')).href };
    const request = { sender: { mainFrame: frame }, senderFrame: frame };
    return handlers.get(channel)(request, ...args);
  };
  const state = () => context.__mainTestExports.statePayload();

  return {
    app, events, handlers, children, files, calls, electron, FakeBrowserWindow,
    boot, flush, advance, invoke, state, configFile,
    get widget() { return FakeBrowserWindow.all[0]; },
    get fetchCalls() { return fetchCalls; },
    get decryptCalls() { return decryptCalls; },
    get timers() { return timers; },
    get exports() { return context.__mainTestExports; },
    event
  };
}

function validConfig(overrides = {}) {
  return {
    panelUrl: 'https://panel.example.com',
    securePath: 'adminpath',
    tokenEncrypted: Buffer.from('encrypted:Bearer old-token').toString('base64'),
    placement: 'floating',
    ...overrides
  };
}

test('启动时先显示小窗，再开始 pending fetch', async () => {
  const request = deferred();
  const h = makeHarness({ config: validConfig(), fetchImpl: () => request.promise });
  await h.boot();
  h.widget.emit('ready-to-show');
  await h.flush();
  assert.deepEqual(h.events.slice(0, 2), ['window:showInactive', 'window:showInactive']);
  assert.equal(h.fetchCalls, 1);
  request.resolve({ ok: true, json: async () => ({ todayIncome: 1, ticketPendingTotal: 2, commissionPendingTotal: 3 }) });
  await h.flush();
});

test('无配置时也显示小窗且不访问网络', async () => {
  const h = makeHarness();
  await h.boot();
  h.widget.emit('ready-to-show');
  await h.flush();
  assert.equal(h.widget.visible, true);
  assert.equal(h.fetchCalls, 0);
  assert.equal(h.state().connectionStatus, 'unconfigured');
});

test('样式保存保留凭证且不触发网络', async () => {
  const original = validConfig();
  const h = makeHarness({ config: original });
  await h.boot();
  const result = await h.invoke('settings:save', {
    placement: 'floating', corner: 'top-left', positionX: 20, positionY: 30,
    panelOpacity: 0.7, textOpacity: 0.9, panelRadius: 12, openAtLogin: false
  });
  assert.equal(result.ok, true);
  assert.equal(h.fetchCalls, 0);
  assert.equal(h.decryptCalls, 0);
  const persisted = JSON.parse(h.files.get(h.configFile));
  assert.equal(persisted.tokenEncrypted, original.tokenEncrypted);
  assert.equal(persisted.panelOpacity, 0.7);
});

test('连接信息保存立即返回，成功后状态为 connected', async () => {
  const response = deferred();
  const h = makeHarness({ fetchImpl: () => response.promise });
  await h.boot();
  const result = await h.invoke('settings:save-connection', {
    panelUrl: 'https://panel.example.com', securePath: 'adminpath', authorization: 'Bearer new-token'
  });
  assert.equal(result.ok, true);
  assert.equal(h.fetchCalls, 1);
  assert.equal(h.state().connectionStatus, 'connecting');
  response.resolve({ ok: true, json: async () => ({ todayIncome: 11, ticketPendingTotal: 2, commissionPendingTotal: 1 }) });
  await h.flush();
  assert.equal(h.state().connectionStatus, 'connected');
  assert.equal(h.state().stats.todayIncome, 11);
});

test('连接失败会自动重试', async () => {
  let second;
  const h = makeHarness({
    config: validConfig(),
    fetchImpl: (call) => call === 1 ? Promise.reject(new Error('network down')) : (second = deferred()).promise
  });
  await h.boot();
  await h.invoke('widget:refresh');
  await h.flush();
  assert.equal(h.state().connectionStatus, 'error');
  await h.advance(5000);
  assert.equal(h.fetchCalls, 2);
  second.resolve({ ok: true, json: async () => ({ todayIncome: 4, ticketPendingTotal: 0, commissionPendingTotal: 0 }) });
  await h.flush();
  assert.equal(h.state().connectionStatus, 'connected');
});

test('替换连接后旧响应不能覆盖新状态', async () => {
  const requests = [];
  const h = makeHarness({ fetchImpl: () => { const request = deferred(); requests.push(request); return request.promise; } });
  await h.boot();
  await h.invoke('settings:save-connection', {
    panelUrl: 'https://panel.example.com', securePath: 'firstpath', authorization: 'Bearer first'
  });
  await h.invoke('settings:save-connection', {
    panelUrl: 'https://panel.example.com', securePath: 'secondpath', authorization: 'Bearer second'
  });
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, json: async () => ({ todayIncome: 22, ticketPendingTotal: 2, commissionPendingTotal: 2 }) });
  await h.flush();
  requests[0].resolve({ ok: true, json: async () => ({ todayIncome: 11, ticketPendingTotal: 1, commissionPendingTotal: 1 }) });
  await h.flush();
  assert.equal(h.state().stats.todayIncome, 22);
  assert.equal(h.state().connectionStatus, 'connected');
});

test('桌面挂载失败后窗口保持显示并自动重试', async () => {
  const h = makeHarness({ config: validConfig({ placement: 'desktop' }) });
  await h.boot();
  h.widget.emit('ready-to-show');
  await h.flush();
  assert.equal(h.children.length, 1);
  h.children[0].emit('error', new Error('attach failed'));
  await h.flush();
  assert.equal(h.widget.visible, true);
  assert.equal(h.events.includes('window:hide'), false);
  await h.advance(1500);
  assert.equal(h.children.length, 2);
  h.children[1].stdout.emit('data', Buffer.from('ATTACHED'));
  await h.flush();
  assert.equal(h.widget.visible, true);
  assert.equal(h.events.includes('window:hide'), false);
});
