'use strict';

const api = window.dashboardWidget.settings;
const form = document.getElementById('settings-form');
const message = document.getElementById('form-message');
const connectionMessage = document.getElementById('connection-message');
const saveButton = document.getElementById('save-button');
const saveConnectionButton = document.getElementById('save-connection-button');
const token = document.getElementById('authorization');
const positionX = document.getElementById('position-x');
const positionY = document.getElementById('position-y');
const panelOpacity = document.getElementById('panel-opacity');
const textOpacity = document.getElementById('text-opacity');
const panelRadius = document.getElementById('panel-radius');
let savedConfig = null;
let previewFrame = 0;
let connectionStatus = 'unconfigured';

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `form-message ${type}`.trim();
}

function setConnectionMessage(text, type = '') {
  connectionMessage.textContent = text;
  connectionMessage.className = `connection-message ${type}`.trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
}

function updatePositionLabel(input, labelId) {
  const label = document.getElementById(labelId);
  label.textContent = `${input.value} / ${input.max} px`;
}

function setPositionControl(input, labelId, value, max) {
  const safeMax = Math.max(0, Math.round(Number(max) || 0));
  input.max = String(safeMax);
  input.value = String(Math.round(clamp(value, 0, safeMax)));
  updatePositionLabel(input, labelId);
}

function syncPositionBounds(config) {
  setPositionControl(positionX, 'position-x-label', config.positionX, config.positionBounds?.xMax);
  setPositionControl(positionY, 'position-y-label', config.positionY, config.positionBounds?.yMax);
}

function populateAppearance(config = {}) {
  savedConfig = { ...(savedConfig || {}), ...config };
  const placementInput = document.querySelector(`input[name="placement"][value="${config.placement || 'desktop'}"]`);
  if (placementInput) placementInput.checked = true;
  setPositionControl(positionX, 'position-x-label', config.positionX, config.positionBounds?.xMax);
  setPositionControl(positionY, 'position-y-label', config.positionY, config.positionBounds?.yMax);
  const panelPercent = Math.round(clamp((config.panelOpacity ?? config.opacity ?? 0.88) * 100, 0, 100));
  const textPercent = Math.round(clamp((config.textOpacity ?? 1) * 100, 0, 100));
  const radius = Math.round(clamp(config.panelRadius ?? 17, 0, 32));
  panelOpacity.value = String(panelPercent);
  textOpacity.value = String(textPercent);
  panelRadius.value = String(radius);
  document.getElementById('panel-opacity-label').textContent = `${panelPercent}%`;
  document.getElementById('text-opacity-label').textContent = `${textPercent}%`;
  document.getElementById('panel-radius-label').textContent = `${radius} px`;
  document.getElementById('open-at-login').checked = Boolean(config.openAtLogin);
}

function populateConnection(config = {}) {
  savedConfig = { ...(savedConfig || {}), ...config };
  document.getElementById('panel-url').value = config.panelUrl || '';
  document.getElementById('secure-path').value = config.securePath || '';
  document.getElementById('token-hint').textContent = config.hasToken ? '留空则保留已加密授权值' : '必填';
}

function populate(config = {}) {
  populateAppearance(config);
  populateConnection(config);
}

function preview() {
  if (previewFrame) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    api.preview({
      positionX: Number(positionX.value),
      positionY: Number(positionY.value),
      panelOpacity: Number(panelOpacity.value) / 100,
      textOpacity: Number(textOpacity.value) / 100,
      panelRadius: Number(panelRadius.value)
    }).catch((error) => setMessage(error?.message || '预览设置失败。', 'error'));
  });
}

function cancelPreview() {
  if (!previewFrame) return;
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
}

positionX.addEventListener('input', () => {
  updatePositionLabel(positionX, 'position-x-label');
  preview();
});
positionY.addEventListener('input', () => {
  updatePositionLabel(positionY, 'position-y-label');
  preview();
});
panelOpacity.addEventListener('input', () => {
  document.getElementById('panel-opacity-label').textContent = `${panelOpacity.value}%`;
  preview();
});
textOpacity.addEventListener('input', () => {
  document.getElementById('text-opacity-label').textContent = `${textOpacity.value}%`;
  preview();
});
panelRadius.addEventListener('input', () => {
  document.getElementById('panel-radius-label').textContent = `${panelRadius.value} px`;
  preview();
});

token.addEventListener('input', () => {
  if (token.value) document.getElementById('token-hint').textContent = '新授权值会替换本机保存值';
  else document.getElementById('token-hint').textContent = savedConfig?.hasToken ? '留空则保留已加密授权值' : '必填';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  cancelPreview();
  saveButton.disabled = true;
  saveButton.classList.add('loading');
  const placement = document.querySelector('input[name="placement"]:checked')?.value || 'desktop';
  try {
    const result = await api.saveAppearance({
      placement,
      positionX: Number(positionX.value),
      positionY: Number(positionY.value),
      panelOpacity: Number(panelOpacity.value) / 100,
      textOpacity: Number(textOpacity.value) / 100,
      panelRadius: Number(panelRadius.value),
      openAtLogin: document.getElementById('open-at-login').checked
    });
    populateAppearance(result.config);
    setMessage('显示设置已保存。', 'success');
  } catch (error) {
    setMessage(error?.message || '显示设置保存失败，请重试。', 'error');
  } finally {
    saveButton.disabled = false;
    saveButton.classList.remove('loading');
  }
});

saveConnectionButton.addEventListener('click', async () => {
  const panelUrl = document.getElementById('panel-url');
  const securePath = document.getElementById('secure-path');
  if (!panelUrl.reportValidity() || !securePath.reportValidity() || (!token.value && !savedConfig?.hasToken)) {
    if (!token.value && !savedConfig?.hasToken) {
      token.setCustomValidity('请填写 Authorization 授权值。');
      token.reportValidity();
      token.setCustomValidity('');
    }
    return;
  }

  saveConnectionButton.disabled = true;
  saveConnectionButton.classList.add('loading');
  setMessage('正在保存连接信息…');
  try {
    const result = await api.saveConnection({
      panelUrl: panelUrl.value,
      securePath: securePath.value,
      authorization: token.value
    });
    if (result?.config) populateConnection(result.config);
    token.value = '';
    if (connectionStatus !== 'connected') setConnectionMessage('连接信息已保存，正在连接…');
  } catch (error) {
    setConnectionMessage(error?.message || '连接信息保存失败，请检查填写内容。', 'error');
  } finally {
    saveConnectionButton.disabled = false;
    saveConnectionButton.classList.remove('loading');
  }
});

document.getElementById('cancel-button').addEventListener('click', () => {
  cancelPreview();
  api.cancel();
});

api.get().then(populate).catch((error) => setMessage(error?.message || '读取设置失败。', 'error'));
api.onState((state) => {
  if (state?.config?.positionBounds) syncPositionBounds(state.config);
  if (state?.placementNotice) setMessage(state.placementNotice, 'warning');
  if (state?.connectionStatus) connectionStatus = state.connectionStatus;
  if (connectionStatus === 'connecting') setConnectionMessage('正在连接…');
  if (connectionStatus === 'connected') setConnectionMessage('已连接，统计数据会自动更新。', 'success');
  if (connectionStatus === 'error') setConnectionMessage(`连接失败：${state.error || '请检查连接信息。'} 将自动重试。`, 'error');
  if (connectionStatus === 'unconfigured') setConnectionMessage('尚未配置连接信息。', 'warning');
});
