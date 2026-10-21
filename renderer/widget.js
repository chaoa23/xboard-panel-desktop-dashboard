'use strict';

const api = window.dashboardWidget.widget;
const byId = (id) => document.getElementById(id);
const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function renderIncomeDescription(value) {
  const growthValue = byId('income-growth-value');
  const growth = Number(value);
  const description = byId('income-description');
  const trendIcon = byId('income-trend-icon');
  if (value === null || value === undefined || !Number.isFinite(growth)) {
    growthValue.textContent = '';
    description.hidden = true;
    trendIcon.hidden = true;
    return;
  }

  description.hidden = false;
  trendIcon.hidden = false;
  growthValue.textContent = `${growth > 0 ? '+' : '-'}${Math.abs(growth)}%`;
  const trendClass = growth > 0 ? 'positive' : 'negative';
  growthValue.className = trendClass;
  // SVGElement#className is an SVGAnimatedString and cannot be assigned to
  // in strict mode. Use the DOM attribute so a render error cannot prevent
  // the connected state from hiding the connection notice.
  trendIcon.setAttribute('class', `trend-icon ${trendClass}`);
}

function renderAppearance(config = {}) {
  const panelOpacity = Number(config.panelOpacity ?? config.opacity ?? 0.88);
  const textOpacity = Number(config.textOpacity ?? 1);
  const configuredRadius = Number(config.panelRadius ?? 17);
  const panel = Math.min(1, Math.max(0, Number.isFinite(panelOpacity) ? panelOpacity : 0.88));
  const text = Math.min(1, Math.max(0, Number.isFinite(textOpacity) ? textOpacity : 1));
  const radius = Math.min(32, Math.max(0, Number.isFinite(configuredRadius) ? configuredRadius : 17));
  document.documentElement.style.setProperty('--panel-opacity', String(panel));
  document.documentElement.style.setProperty('--panel-border-opacity', String(.30 * panel));
  document.documentElement.style.setProperty('--panel-background-a', String(.96 * panel));
  document.documentElement.style.setProperty('--panel-background-b', String(.88 * panel));
  document.documentElement.style.setProperty('--panel-shadow-opacity', String(.28 * panel));
  document.documentElement.style.setProperty('--panel-highlight-opacity', String(.10 * panel));
  document.documentElement.style.setProperty('--panel-blur', `${Math.round(20 * panel)}px`);
  document.documentElement.style.setProperty('--notice-border-opacity', String(.28 * panel));
  document.documentElement.style.setProperty('--notice-background-opacity', String(.96 * panel));
  document.documentElement.style.setProperty('--text-opacity', String(text));
  document.documentElement.style.setProperty('--panel-radius', `${radius}px`);
}

function render(state) {
  if (!state) return;
  renderAppearance(state.config || {});
  const stats = state.stats;

  if (stats) {
    byId('income-value').textContent = `¥${currencyFormatter.format(stats.todayIncome / 100)}`;
    byId('tickets-value').textContent = formatter.format(stats.ticketPendingTotal);
    byId('commission-value').textContent = formatter.format(stats.commissionPendingTotal);
    renderIncomeDescription(stats.dayIncomeGrowth);
    byId('tickets-description').textContent = stats.ticketPendingTotal > 0
      ? '有工单需要处理'
      : '无待处理工单';
    byId('commission-description').textContent = stats.commissionPendingTotal > 0
      ? '有佣金需要确认'
      : '无待处理佣金';
  } else {
    byId('income-value').textContent = '—';
    byId('tickets-value').textContent = '—';
    byId('commission-value').textContent = '—';
    byId('tickets-description').textContent = '';
    byId('commission-description').textContent = '';
    renderIncomeDescription(null);
  }

  const connectionStatus = state.connectionStatus || 'connecting';
  const hasError = connectionStatus === 'error' || Boolean(state.error);
  document.body.classList.toggle('stale', hasError && Boolean(stats));
  let connectionNotice = '';
  if (connectionStatus === 'unconfigured') connectionNotice = '请先在设置中保存连接信息。';
  if (connectionStatus === 'connecting') connectionNotice = '正在连接…';
  if (connectionStatus === 'error') connectionNotice = `连接失败：${state.error || '请检查连接信息。'} 将自动重试。`;
  const noticeText = state.placementNotice || connectionNotice;
  const notice = byId('notice');
  ['connecting', 'error'].forEach((status) => notice.classList.toggle(`notice-${status}`, connectionStatus === status));
  ['connecting', 'error', 'connected', 'unconfigured'].forEach((status) => document.body.classList.toggle(`connection-status-${status}`, connectionStatus === status));
  byId('notice-text').textContent = noticeText;
  notice.hidden = !noticeText;
  document.body.classList.toggle('has-notice', Boolean(noticeText));
}

api.onState(render);
api.onPreview(renderAppearance);
render({ connectionStatus: 'connecting' });
api.getState().then(render);
