'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function makeElement(id) {
  const listeners = {};
  const element = {
    id, value: '', textContent: '', hidden: false, checked: false, max: '0', className: '', attributes: {},
    style: { setProperty() {} },
    classList: {
      toggle(name, enabled) { this[name] = enabled; },
      add(name) { this[name] = true; },
      remove(name) { this[name] = false; }
    },
    addEventListener(type, callback) { listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    dispatch(type, event = {}) { return listeners[type]?.(event); },
    reportValidity() { return true; },
    setCustomValidity() {}
  };
  if (id === 'income-trend-icon') {
    Object.defineProperty(element, 'className', {
      get() { return { baseVal: this.attributes.class || '' }; },
      set() { throw new TypeError('SVGAnimatedString.className is read-only'); }
    });
  }
  return element;
}

async function testWidgetConnectedHidesNotice() {
  const ids = ['income-value', 'income-description', 'income-trend-icon', 'income-growth-value', 'tickets-value', 'tickets-description', 'commission-value', 'commission-description', 'notice', 'notice-text'];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  const stateListeners = [];
  const context = {
    window: { dashboardWidget: { widget: {
      onState(callback) { stateListeners.push(callback); }, onPreview() {},
      getState() { return Promise.resolve({ connectionStatus: 'connecting' }); }
    } } },
    document: { documentElement: { style: { setProperty() {} } }, body: { classList: { toggle() {} } }, getElementById(id) { return elements[id]; } },
    Intl, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer/widget.js'), 'utf8'), context);
  stateListeners[0]({ connectionStatus: 'connected', stats: null });
  assert.equal(elements.notice.hidden, true);
  assert.equal(elements.notice.classList['notice-connecting'], false);
  assert.equal(elements['income-value'].textContent, '—');

  stateListeners[0]({
    connectionStatus: 'connected',
    stats: { todayIncome: 100, ticketPendingTotal: 0, commissionPendingTotal: 0, dayIncomeGrowth: 3 }
  });
  assert.equal(elements['income-growth-value'].className, 'positive');
  assert.equal(elements['income-trend-icon'].attributes.class, 'trend-icon positive');
  assert.equal(elements.notice.hidden, true);

  stateListeners[0]({
    connectionStatus: 'connected',
    stats: { todayIncome: 100, ticketPendingTotal: 0, commissionPendingTotal: 0, dayIncomeGrowth: -2 }
  });
  assert.equal(elements['income-growth-value'].className, 'negative');
  assert.equal(elements['income-trend-icon'].attributes.class, 'trend-icon negative');
}

async function testAppearanceSaveOmitsConnectionFields() {
  const ids = ['settings-form', 'form-message', 'connection-message', 'save-button', 'save-connection-button', 'authorization', 'position-x', 'position-y', 'panel-opacity', 'text-opacity', 'panel-radius', 'panel-url', 'secure-path', 'token-hint', 'position-x-label', 'position-y-label', 'panel-opacity-label', 'text-opacity-label', 'panel-radius-label', 'open-at-login', 'cancel-button'];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  const appearanceCalls = [];
  const context = {
    window: { dashboardWidget: { settings: {
      saveAppearance(input) { appearanceCalls.push(input); return Promise.resolve({ config: { placement: 'desktop' } }); },
      saveConnection() { throw new Error('connection save must not be called'); }, preview() { return Promise.resolve(); },
      get() { return Promise.resolve({ placement: 'desktop', hasToken: true }); }, onState() {}, cancel() {}
    } } },
    document: { getElementById(id) { return elements[id]; }, querySelector() { return { checked: true, value: 'desktop' }; } },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer/settings.js'), 'utf8'), context);
  await elements['settings-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(appearanceCalls.length, 1);
  assert.deepEqual(Object.keys(appearanceCalls[0]).sort(), ['openAtLogin', 'panelOpacity', 'panelRadius', 'placement', 'positionX', 'positionY', 'textOpacity']);
}

Promise.resolve().then(testWidgetConnectedHidesNotice).then(testAppearanceSaveOmitsConnectionFields).then(() => console.log('renderer tests passed'));
