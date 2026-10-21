'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, safeStorage } = require('electron');

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'boheyun-widget-smoke-'));
const screenshotPath = path.join(os.tmpdir(), `boheyun-widget-smoke-${process.pid}.png`);
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ code, message, screenshotPath }));
  app.quit();
  setTimeout(() => app.exit(code), 1200);
}

process.on('exit', () => {
  try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* Temporary test profile only. */ }
});

app.setPath('userData', dataPath);
// Never change Windows login items while testing an isolated copy.
app.setLoginItemSettings = () => {};
app.whenReady().then(() => {
  const config = {
    panelUrl: 'https://127.0.0.1:1',
    securePath: 'smoketest',
    tokenEncrypted: safeStorage.encryptString('Bearer smoke-test-only').toString('base64'),
    placement: 'desktop',
    corner: 'top-left',
    panelOpacity: 0.88,
    textOpacity: 1,
    panelRadius: 17,
    openAtLogin: false
  };
  fs.writeFileSync(path.join(dataPath, 'settings.json'), JSON.stringify(config));
  require('../electron/main.js');

  setTimeout(async () => {
    try {
      const widget = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/renderer/widget.html'));
      assert.ok(widget, 'widget window was created');
      assert.equal(widget.isVisible(), true, 'widget is visible while connection runs in background');
      const state = await widget.webContents.executeJavaScript(`({
        notice: document.getElementById('notice-text').textContent,
        hidden: document.getElementById('notice').hidden,
        configured: document.body.className
      })`);
      assert.equal(state.hidden, false, 'connection state is visible');
      assert.match(state.notice, /正在连接|连接失败/);

      const svgClassNameAssignmentThrows = await widget.webContents.executeJavaScript(`(() => {
        const icon = document.getElementById('income-trend-icon');
        try {
          (function () { 'use strict'; icon.className = 'trend-icon positive'; })();
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      })()`);
      assert.equal(svgClassNameAssignmentThrows, true, 'SVG className assignment is read-only in Chromium strict mode');

      const trendStates = await widget.webContents.executeJavaScript(`(() => {
        render({ connectionStatus: 'connected', stats: {
          todayIncome: 100, ticketPendingTotal: 0, commissionPendingTotal: 0, dayIncomeGrowth: 3
        } });
        const notice = document.getElementById('notice');
        const icon = document.getElementById('income-trend-icon');
        const value = document.getElementById('income-growth-value');
        const positive = {
          noticeHidden: notice.hidden,
          iconClass: icon.getAttribute('class'),
          iconColor: getComputedStyle(icon).color,
          valueColor: getComputedStyle(value).color
        };
        render({ connectionStatus: 'connected', stats: {
          todayIncome: 100, ticketPendingTotal: 0, commissionPendingTotal: 0, dayIncomeGrowth: -2
        } });
        return {
          positive,
          negative: {
            noticeHidden: notice.hidden,
            iconClass: icon.getAttribute('class'),
            iconColor: getComputedStyle(icon).color,
            valueColor: getComputedStyle(value).color
          }
        };
      })()`);
      assert.equal(trendStates.positive.noticeHidden, true, 'successful data hides the connecting notice');
      assert.equal(trendStates.positive.iconClass, 'trend-icon positive');
      assert.equal(trendStates.positive.iconColor, trendStates.positive.valueColor, 'growth arrow matches positive percentage color');
      assert.equal(trendStates.positive.iconColor, 'rgb(16, 185, 129)', 'positive growth uses the dashboard emerald color');
      assert.equal(trendStates.negative.noticeHidden, true, 'connected notice stays hidden for negative growth');
      assert.equal(trendStates.negative.iconClass, 'trend-icon negative');
      assert.equal(trendStates.negative.iconColor, trendStates.negative.valueColor, 'growth arrow matches negative percentage color');
      assert.equal(trendStates.negative.iconColor, 'rgb(239, 68, 68)', 'negative growth uses the dashboard red color');

      const image = await widget.capturePage();
      fs.writeFileSync(screenshotPath, image.toPNG());
      finish(0, 'isolated desktop-layer startup smoke test passed');
    } catch (error) {
      finish(1, error?.stack || String(error));
    }
  }, 3500);
}).catch((error) => finish(1, error?.stack || String(error)));
