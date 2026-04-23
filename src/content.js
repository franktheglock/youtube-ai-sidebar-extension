import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { YoutubeTranscript } from 'youtube-transcript';

const HOST_ID = 'yt-ai-sidebar-host';
const LAUNCHER_ID = 'yt-ai-sidebar-launcher';
const LAUNCHER_STYLE_ID = 'yt-ai-sidebar-launcher-style';
const PANEL_TITLE = 'Ask This Video';
const DEFAULT_STARTER_QUESTION = 'Summarize this video';
const REQUEST_START_TIMEOUT_MS = 4000;
const MAX_REQUEST_START_RETRIES = 2;
let port = null;

const state = {
  currentVideoId: '',
  sidebarOpen: false,
  transcriptSegments: [],
  transcriptText: '',
  transcriptStatus: 'Waiting for a YouTube video',
  starterQuestions: [],
  startersDismissed: false,
  messages: [],
  activeRequestId: null,
  activeRequestPendingPayload: null,
  activeRequestStartTimeoutId: null,
  activeRequestHasResponse: false,
  activeRequestStatusText: '',
  transcriptRequestId: null,
  pendingFrameContext: null,
  activeRequestReasoningActive: false,
  activeRequestReasoningOpen: false,
  activeProvider: '',
  activeModel: '',
  modelCatalogGroups: [],
  modelCatalogLoading: false,
  modelCatalogError: '',
  modelPickerOpen: false,
  modelSearchQuery: ''
};

const ui = {
  shadow: null,
  host: null,
  secondaryInner: null,
  secondaryResizeObserver: null,
  panel: null,
  conversation: null,
  status: null,
  transcriptMeta: null,
  starters: null,
  messages: null,
  modelPickerButton: null,
  modelPickerLabel: null,
  modelPickerPanel: null,
  form: null,
  input: null,
  frameButton: null,
  frameButtonLabel: null,
  framePreview: null,
  send: null,
  close: null,
  launcher: null
};

marked.setOptions({
  gfm: true,
  breaks: true
});

function handlePortMessage(message) {
  if (!message || message.requestId !== state.activeRequestId && message.type !== 'starter-questions-result') {
    return;
  }

  if (message.type === 'assistant-started') {
    clearActiveRequestStartTimeout();
    state.activeRequestReasoningActive = false;
    state.activeRequestReasoningOpen = false;
    return;
  }

  if (message.type === 'assistant-clear') {
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      lastMessage.text = '';
      lastMessage.reasoningPreview = '';
    }
    state.activeRequestReasoningActive = false;
    state.activeRequestReasoningOpen = false;
    state.activeRequestHasResponse = false;
    renderMessages();
    return;
  }

  if (message.type === 'assistant-status') {
    if (typeof message.status === 'string' && message.status.trim()) {
      state.activeRequestStatusText = message.status.trim();
      updateStatus(state.activeRequestStatusText);
      renderMessages();
    }
    return;
  }

  if (message.type === 'assistant-chunk') {
    state.activeRequestHasResponse = true;
    clearActiveRequestStartTimeout();
    state.activeRequestStatusText = '';
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      if (message.chunk.includes('<details')) {
        state.activeRequestReasoningActive = true;
        lastMessage.reasoningPreview = lastMessage.reasoningPreview || 'Thinking…';
      } else if (message.chunk.includes('</details>')) {
        state.activeRequestReasoningActive = false;
        lastMessage.reasoningPreview = '';
      } else if (state.activeRequestReasoningActive) {
        lastMessage.reasoningPreview = (lastMessage.reasoningPreview === 'Thinking…' ? '' : lastMessage.reasoningPreview) + message.chunk;
      }

      lastMessage.text += message.chunk;
      renderMessages();
    }
    return;
  }

  if (message.type === 'sources') {
    clearActiveRequestStartTimeout();
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      lastMessage.sources = message.sources || [];
      renderMessages();
    }
    return;
  }

  if (message.type === 'assistant-done') {
    state.activeRequestReasoningActive = false;
    state.activeRequestReasoningOpen = false;
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      lastMessage.reasoningPreview = '';
    }
    clearActiveRequestTracking();
    state.activeRequestId = null;
    updateStatus('Ready');
    renderMessages();
    return;
  }

  if (message.type === 'assistant-error') {
    clearActiveRequestTracking();
    state.activeRequestReasoningOpen = false;
    state.activeRequestId = null;
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      lastMessage.text = `The request failed: ${message.error}`;
    }
    updateStatus('Request failed');
    renderMessages();
    return;
  }

  if (message.type === 'assistant-cancelled') {
    clearActiveRequestTracking();
    state.activeRequestReasoningOpen = false;
    state.activeRequestId = null;
    updateStatus('Cancelled');
    return;
  }

  if (message.type === 'starter-questions-result' && message.requestId === state.transcriptRequestId) {
    state.starterQuestions = Array.isArray(message.questions) ? message.questions : [];
    renderStarters();
  }
}

function clearActiveRequestStartTimeout() {
  if (state.activeRequestStartTimeoutId) {
    window.clearTimeout(state.activeRequestStartTimeoutId);
    state.activeRequestStartTimeoutId = null;
  }
}

function clearActiveRequestTracking() {
  clearActiveRequestStartTimeout();
  state.activeRequestPendingPayload = null;
  state.activeRequestHasResponse = false;
  state.activeRequestStatusText = '';
  state.activeRequestReasoningActive = false;
  state.activeRequestReasoningOpen = false;
}

async function ensureModelCatalogLoaded(force = false) {
  if (state.modelCatalogLoading) {
    return;
  }

  if (!force && state.modelCatalogGroups.length) {
    renderModelPicker();
    return;
  }

  state.modelCatalogLoading = true;
  state.modelCatalogError = '';
  renderModelPicker();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-model-catalog' });
    if (!response?.ok) {
      throw new Error(response?.error || 'The model catalog could not be loaded.');
    }

    state.activeProvider = String(response.settings?.provider || '');
    state.activeModel = String(response.settings?.model || '');
    state.modelCatalogGroups = Array.isArray(response.groups) ? response.groups : [];
  } catch (error) {
    state.modelCatalogError = error instanceof Error ? error.message : 'The model catalog could not be loaded.';
  } finally {
    state.modelCatalogLoading = false;
    renderModelPicker();
  }
}

async function selectActiveModel(provider, model) {
  if (!provider || !model) {
    return;
  }

  if (state.activeRequestId) {
    updateStatus('Wait for the current response to finish before switching models.');
    return;
  }

  updateStatus('Switching model...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'set-active-model',
      provider,
      model
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'The active model could not be updated.');
    }

    state.activeProvider = String(response.settings?.provider || provider);
    state.activeModel = String(response.settings?.model || model);
    state.modelPickerOpen = false;
    renderModelPicker();
    updateStatus(`Ready • ${formatProviderLabel(state.activeProvider)} / ${state.activeModel}`);
  } catch (error) {
    updateStatus(error instanceof Error ? error.message : 'The active model could not be updated.');
  }
}

function renderModelPicker({ preserveSearchFocus = false, searchSelectionStart = null, searchSelectionEnd = null } = {}) {
  if (!ui.modelPickerButton || !ui.modelPickerLabel || !ui.modelPickerPanel) {
    return;
  }

  const activeLabel = state.activeModel || 'Choose model';
  ui.modelPickerLabel.textContent = activeLabel;
  ui.modelPickerButton.setAttribute('aria-expanded', state.modelPickerOpen ? 'true' : 'false');
  ui.modelPickerButton.classList.toggle('header__model-button--open', state.modelPickerOpen);
  ui.modelPickerPanel.hidden = !state.modelPickerOpen;

  if (!state.modelPickerOpen) {
    return;
  }

  const groups = getFilteredModelGroups();
  const statusMarkup = state.modelCatalogLoading
    ? '<div class="model-picker__empty">Loading models from configured endpoints...</div>'
    : state.modelCatalogError
      ? `<div class="model-picker__empty">${escapeHtml(state.modelCatalogError)}</div>`
      : groups.length === 0
        ? '<div class="model-picker__empty">No models matched your search.</div>'
        : groups.map(renderModelGroup).join('');

  ui.modelPickerPanel.innerHTML = `
    <div class="model-picker__surface">
      <div class="model-picker__toolbar">
        <input data-role="model-search-input" class="model-picker__search" type="text" placeholder="Search models or providers..." value="${escapeHtml(state.modelSearchQuery)}" />
        <button class="model-picker__refresh" type="button" data-action="refresh-model-picker">Refresh</button>
      </div>
      <div class="model-picker__list">${statusMarkup}</div>
    </div>
  `;

  ui.modelPickerPanel.querySelector('[data-action="refresh-model-picker"]')?.addEventListener('click', () => {
    void ensureModelCatalogLoaded(true);
  });

  if (preserveSearchFocus) {
    const searchInput = ui.modelPickerPanel.querySelector('[data-role="model-search-input"]');
    if (searchInput instanceof HTMLInputElement) {
      searchInput.focus();
      const start = Number.isInteger(searchSelectionStart) ? searchSelectionStart : searchInput.value.length;
      const end = Number.isInteger(searchSelectionEnd) ? searchSelectionEnd : searchInput.value.length;
      try {
        searchInput.setSelectionRange(start, end);
      } catch {
        // Ignore selection issues for browsers that do not support it here.
      }
    }
  }
}

function getFilteredModelGroups() {
  const query = state.modelSearchQuery.trim().toLowerCase();
  const groups = Array.isArray(state.modelCatalogGroups) ? state.modelCatalogGroups : [];
  if (!query) {
    return groups;
  }

  return groups
    .map((group) => ({
      ...group,
      models: (Array.isArray(group.models) ? group.models : []).filter((model) => {
        const haystack = [group.label, model.id, model.name, model.ownedBy].join(' ').toLowerCase();
        return haystack.includes(query);
      })
    }))
    .filter((group) => !group.available || group.models.length > 0 || group.label.toLowerCase().includes(query));
}

function renderModelGroup(group) {
  const models = Array.isArray(group.models) ? group.models : [];
  const errorMarkup = !group.available
    ? `<div class="model-picker__group-note">${escapeHtml(group.error || 'Unavailable')}</div>`
    : '';
  const itemsMarkup = group.available && models.length
    ? models.map((model) => renderModelOption(group, model)).join('')
    : group.available
      ? '<div class="model-picker__group-note">This endpoint returned no models.</div>'
      : '';

  return `
    <section class="model-picker__group ${group.provider === state.activeProvider ? 'model-picker__group--active' : ''}">
      <div class="model-picker__group-header">
        <strong>${escapeHtml(group.label)}</strong>
        <span>${group.available ? `${models.length} models` : 'Unavailable'}</span>
      </div>
      ${errorMarkup}
      ${itemsMarkup}
    </section>
  `;
}

function renderModelOption(group, model) {
  const isActive = group.provider === state.activeProvider && model.id === state.activeModel;
  const metaParts = [];
  if (model.ownedBy) {
    metaParts.push(model.ownedBy);
  }
  if (model.contextLength > 0) {
    metaParts.push(`${formatCompactNumber(model.contextLength)} ctx`);
  }

  return `
    <button
      type="button"
      class="model-option ${isActive ? 'model-option--active' : ''}"
      data-provider="${escapeHtml(group.provider)}"
      data-model="${escapeHtml(model.id)}"
    >
      <span class="model-option__title">${escapeHtml(model.name || model.id)}</span>
      <span class="model-option__id">${escapeHtml(model.id)}</span>
      <span class="model-option__meta">${escapeHtml(metaParts.join(' • ') || group.label)}</span>
    </button>
  `;
}

function formatProviderLabel(provider) {
  if (provider === 'lmstudio') {
    return 'LM Studio';
  }

  if (provider === 'nvidia-nim') {
    return 'NVIDIA NIM';
  }

  return 'OpenRouter';
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  if (value >= 1000000) {
    return `${Math.round(value / 100000) / 10}M`;
  }

  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}K`;
  }

  return String(Math.round(value));
}

async function captureCurrentFrameContext() {
  const video = document.querySelector('video');
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error('No active video frame is available on this page.');
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('Wait for the current video frame to load before capturing it.');
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 24) {
    throw new Error('The video is not visible enough on screen to capture.');
  }

  updateStatus('Capturing current frame...');
  const response = await chrome.runtime.sendMessage({ type: 'capture-visible-tab' });
  if (!response?.ok || typeof response.dataUrl !== 'string') {
    throw new Error(response?.error || 'The visible tab could not be captured.');
  }

  const capture = await cropVideoFrameFromScreenshot(response.dataUrl, rect);
  const seconds = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
  state.pendingFrameContext = {
    imageUrl: capture.dataUrl,
    seconds,
    timestamp: formatTimestamp(seconds),
    width: capture.width,
    height: capture.height
  };

  renderComposerFramePreview();
  updateStatus(`Attached current frame at ${state.pendingFrameContext.timestamp}`);
}

async function cropVideoFrameFromScreenshot(screenshotUrl, rect) {
  const screenshot = await loadImage(screenshotUrl);
  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  const scaleX = screenshot.naturalWidth / viewportWidth;
  const scaleY = screenshot.naturalHeight / viewportHeight;
  const cropX = clamp(rect.left * scaleX, 0, screenshot.naturalWidth);
  const cropY = clamp(rect.top * scaleY, 0, screenshot.naturalHeight);
  const cropWidth = clamp(rect.width * scaleX, 1, screenshot.naturalWidth - cropX);
  const cropHeight = clamp(rect.height * scaleY, 1, screenshot.naturalHeight - cropY);
  const maxEdge = 1024;
  const resizeScale = Math.min(1, maxEdge / Math.max(cropWidth, cropHeight));
  const outputWidth = Math.max(1, Math.round(cropWidth * resizeScale));
  const outputHeight = Math.max(1, Math.round(cropHeight * resizeScale));
  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The captured frame could not be prepared.');
  }

  context.drawImage(screenshot, cropX, cropY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.86),
    width: outputWidth,
    height: outputHeight
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('The captured screenshot could not be loaded.')), { once: true });
    image.src = url;
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderComposerFramePreview() {
  if (!ui.framePreview || !ui.frameButtonLabel) {
    return;
  }

  const frame = state.pendingFrameContext;
  ui.framePreview.innerHTML = '';

  if (!frame) {
    ui.framePreview.hidden = true;
    ui.frameButtonLabel.textContent = 'Use current frame';
    return;
  }

  ui.framePreview.hidden = false;
  ui.frameButtonLabel.textContent = 'Recapture frame';

  const chip = document.createElement('div');
  chip.className = 'frame-chip';
  chip.innerHTML = `
    <img class="frame-chip__thumb" src="${frame.imageUrl}" alt="Attached frame preview" />
    <div class="frame-chip__meta">
      <strong>Current frame attached</strong>
      <span>${escapeHtml(frame.timestamp)} • ${frame.width}×${frame.height}</span>
    </div>
    <button class="frame-chip__remove" type="button" aria-label="Remove attached frame">×</button>
  `;

  chip.querySelector('.frame-chip__remove').addEventListener('click', () => {
    state.pendingFrameContext = null;
    renderComposerFramePreview();
    updateStatus('Removed attached frame');
  });

  ui.framePreview.append(chip);
}

function buildUserMessageText(text, frameContext) {
  if (!frameContext?.timestamp) {
    return text;
  }

  return `${text}\n\n[Attached current frame: ${frameContext.timestamp}]`;
}

function scheduleActiveRequestStartTimeout(requestId) {
  clearActiveRequestStartTimeout();
  state.activeRequestStartTimeoutId = window.setTimeout(() => {
    if (state.activeRequestId !== requestId || state.activeRequestHasResponse) {
      return;
    }

    void retryActiveRequest('The request did not start in time.');
  }, REQUEST_START_TIMEOUT_MS);
}

async function retryActiveRequest(fallbackError) {
  const pending = state.activeRequestPendingPayload;
  if (!pending || state.activeRequestId !== pending.requestId || state.activeRequestHasResponse) {
    return false;
  }

  if (pending.retryCount >= MAX_REQUEST_START_RETRIES) {
    clearActiveRequestTracking();
    state.activeRequestId = null;
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant' && !lastMessage.text) {
      lastMessage.text = 'The request could not be started after a few retries. Please try again.';
    }
    updateStatus(fallbackError);
    renderMessages();
    return false;
  }

  pending.retryCount += 1;
  state.activeRequestStatusText = 'Retrying request...';
  updateStatus('Retrying request...');

  try {
    await postToBackground(pending.message, { retries: 1, retryDelayMs: 250 });
    scheduleActiveRequestStartTimeout(pending.requestId);
    return true;
  } catch {
    scheduleActiveRequestStartTimeout(pending.requestId);
    return false;
  }
}

function handlePortDisconnect(disconnectedPort) {
  if (port === disconnectedPort) {
    port = null;
  }

  if (!state.activeRequestId || state.activeRequestHasResponse) {
    return;
  }

  void retryActiveRequest('The request was interrupted before it started.');
}

function connectPort() {
  if (port) {
    return port;
  }

  const nextPort = chrome.runtime.connect({ name: 'yt-ai-sidebar' });
  nextPort.onMessage.addListener(handlePortMessage);
  nextPort.onDisconnect.addListener(() => {
    handlePortDisconnect(nextPort);
  });
  port = nextPort;
  return port;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function postToBackground(message, { retries = 6, retryDelayMs = 300, silent = false } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      connectPort().postMessage(message);
      return true;
    } catch (error) {
      lastError = error;
      port = null;
      if (attempt < retries) {
        await delay(retryDelayMs * (attempt + 1));
      }
    }
  }

  if (silent) {
    return false;
  }

  throw lastError instanceof Error ? lastError : new Error('Background connection failed.');
}

bootstrap();

function bootstrap() {
  connectPort();
  mountWhenReady();
  mountLauncherButton();
  hydrateCurrentVideo();
  window.addEventListener('yt-navigate-finish', onRouteChange);
  window.addEventListener('yt-page-data-updated', onRouteChange);
  window.addEventListener('resize', () => {
    applyResponsiveSidebarWidth();
  });
  setInterval(() => {
    const videoId = getVideoId();
    if (videoId && videoId !== state.currentVideoId) {
      onRouteChange();
    } else {
      updateSidebarVisibility();
    }
  }, 1200);
}

function onRouteChange() {
  mountWhenReady();
  mountLauncherButton();
  hydrateCurrentVideo();
}

function mountWhenReady() {
  if (!getVideoId()) {
    if (ui.host) {
      ui.host.style.display = 'none';
    }
    return; // Don't try to mount if it's not a video page
  }

  const secondaryInner = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
  if (!secondaryInner) {
    requestAnimationFrame(mountWhenReady);
    return;
  }

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('section');
    host.id = HOST_ID;
    host.style.marginBottom = '16px';
    secondaryInner.prepend(host);
  }

  ui.host = host;
  ui.secondaryInner = secondaryInner;
  observeSidebarContainer(secondaryInner);
  applyResponsiveSidebarWidth();
function observeSidebarContainer(container) {
  if (!container || typeof ResizeObserver === 'undefined') {
    return;
  }

  if (ui.secondaryResizeObserver && ui.secondaryInner === container) {
    return;
  }

  ui.secondaryResizeObserver?.disconnect();
  ui.secondaryResizeObserver = new ResizeObserver(() => {
    applyResponsiveSidebarWidth();
  });
  ui.secondaryResizeObserver.observe(container);
}

  if (ui.shadow) {
    return;
  }

  ui.shadow = host.attachShadow({ mode: 'open' });
  ui.shadow.innerHTML = buildShell();
  ui.panel = ui.shadow.querySelector('.panel');
  ui.conversation = ui.shadow.querySelector('.conversation');
  ui.status = ui.shadow.querySelector('[data-role="status"]');
  ui.transcriptMeta = ui.shadow.querySelector('[data-role="transcript-meta"]');
  ui.starters = ui.shadow.querySelector('[data-role="starters"]');
  ui.messages = ui.shadow.querySelector('[data-role="messages"]');
  ui.modelPickerButton = ui.shadow.querySelector('[data-action="toggle-model-picker"]');
  ui.modelPickerLabel = ui.shadow.querySelector('[data-role="model-picker-label"]');
  ui.modelPickerPanel = ui.shadow.querySelector('[data-role="model-picker-panel"]');
  ui.form = ui.shadow.querySelector('form');
  ui.input = ui.shadow.querySelector('textarea');
  ui.frameButton = ui.shadow.querySelector('[data-action="capture-frame"]');
  ui.frameButtonLabel = ui.shadow.querySelector('[data-role="frame-button-label"]');
  ui.framePreview = ui.shadow.querySelector('[data-role="frame-preview"]');
  ui.send = ui.shadow.querySelector('button[type="submit"]');
  ui.close = ui.shadow.querySelector('[data-action="close"]');

  ui.messages.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-seek-seconds]') : null;
    if (!target) {
      return;
    }

    const seconds = Number(target.getAttribute('data-seek-seconds'));
    if (Number.isNaN(seconds)) {
      return;
    }

    event.preventDefault();
    seekToTimestamp(seconds);
  });

  ui.shadow.querySelector('[data-action="new-chat"]').addEventListener('click', () => {
    clearActiveRequestTracking();
    if (state.activeRequestId) {
      chrome.runtime.sendMessage({ 
        type: 'cancel-assistant-request', 
        requestId: state.activeRequestId 
      }).catch(() => {});
      state.activeRequestId = null;
    }
    
    state.startersDismissed = false;
    state.messages = [];
    state.pendingFrameContext = null;
    if (ui.input) ui.input.value = '';

    renderComposerFramePreview();
    renderMessages();
    renderStarters();
    updateStatus(state.transcriptStatus === 'Transcript ready' || state.transcriptStatus === 'Transcript unavailable' ? 'Ready' : state.transcriptStatus);
  });

  ui.shadow.querySelector('[data-action="options"]').addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'open-options-page' });
      if (!response?.ok) {
        throw new Error(response?.error || 'Options page could not be opened.');
      }
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : 'Options page could not be opened.');
    }
  });

  ui.close.addEventListener('click', () => {
    closeSidebar();
  });

  ui.modelPickerButton.addEventListener('click', async () => {
    const nextOpen = !state.modelPickerOpen;
    state.modelPickerOpen = nextOpen;
    renderModelPicker();
    if (nextOpen) {
      await ensureModelCatalogLoaded();
      const searchInput = ui.modelPickerPanel?.querySelector('input');
      searchInput?.focus();
      searchInput?.select();
    }
  });

  ui.modelPickerPanel.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute('data-role') !== 'model-search-input') {
      return;
    }

    const selectionStart = target.selectionStart;
    const selectionEnd = target.selectionEnd;
    state.modelSearchQuery = target.value;
    renderModelPicker({ preserveSearchFocus: true, searchSelectionStart: selectionStart, searchSelectionEnd: selectionEnd });
  });

  ui.modelPickerPanel.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.closest('[data-provider][data-model]') : null;
    if (!action) {
      return;
    }

    void selectActiveModel(action.getAttribute('data-provider') || '', action.getAttribute('data-model') || '');
  });

  const stopModelPickerHotkeys = (event) => {
    if (!state.modelPickerOpen) {
      return;
    }

    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  ui.modelPickerPanel.addEventListener('keydown', stopModelPickerHotkeys, true);
  ui.modelPickerPanel.addEventListener('keypress', stopModelPickerHotkeys, true);
  ui.modelPickerPanel.addEventListener('keyup', stopModelPickerHotkeys, true);

  ui.shadow.addEventListener('click', (event) => {
    if (!state.modelPickerOpen) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest('[data-action="toggle-model-picker"]') || target.closest('[data-role="model-picker-panel"]')) {
      return;
    }

    state.modelPickerOpen = false;
    renderModelPicker();
  });

  ui.frameButton.addEventListener('click', async () => {
    if (state.activeRequestId) {
      return;
    }

    try {
      await captureCurrentFrameContext();
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : 'The current frame could not be captured.');
    }
  });

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.input.value.trim();
    if (!value || state.activeRequestId) {
      return;
    }
    sendChat(value, state.pendingFrameContext);
  });

  const stopYouTubeHotkeys = (event) => {
    if (event.target !== ui.input) {
      return;
    }

    if (event.type === 'keydown' && !event.isComposing && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      ui.form.requestSubmit();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      return;
    }

    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  ui.input.addEventListener('keydown', stopYouTubeHotkeys, true);
  ui.input.addEventListener('keypress', stopYouTubeHotkeys, true);
  ui.input.addEventListener('keyup', stopYouTubeHotkeys, true);

  void ensureModelCatalogLoaded();
  renderModelPicker();
  renderComposerFramePreview();
  renderMessages();
  renderStarters();
  updateStatus(state.transcriptStatus);
  updateSidebarVisibility();
}

function mountLauncherButton() {
  if (!getVideoId()) {
    ui.launcher?.remove();
    ui.launcher = null;
    return;
  }

  ensureLauncherStyles();

  const actionsRow = document.querySelector('#top-level-buttons-computed') || document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
  if (!actionsRow) {
    requestAnimationFrame(mountLauncherButton);
    return;
  }

  let launcher = document.getElementById(LAUNCHER_ID);
  if (!launcher) {
    launcher = document.createElement('button');
    launcher.id = LAUNCHER_ID;
    launcher.type = 'button';
    launcher.className = 'yt-ai-launcher';
    launcher.innerHTML = '<span class="yt-ai-launcher__spark">✦</span><span class="yt-ai-launcher__label">Ask video</span>';
    launcher.addEventListener('click', () => {
      if (state.sidebarOpen) {
        closeSidebar();
      } else {
        openSidebar({ focus: true });
      }
    });
    actionsRow.prepend(launcher);
  } else if (launcher.parentElement !== actionsRow) {
    actionsRow.prepend(launcher);
  }

  ui.launcher = launcher;
  updateSidebarVisibility();
}

function ensureLauncherStyles() {
  if (document.getElementById(LAUNCHER_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = LAUNCHER_STYLE_ID;
  style.textContent = `
    #${LAUNCHER_ID} {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      margin-right: 8px;
      padding: 0 14px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 18px;
      background: #272727;
      color: #f1f1f1;
      font: 500 14px/1 Roboto, Arial, sans-serif;
      cursor: pointer;
    }

    #${LAUNCHER_ID}:hover {
      background: #313131;
    }

    #${LAUNCHER_ID}.yt-ai-launcher--active {
      background: #3a3a3a;
      border-color: rgba(138, 180, 248, 0.34);
    }

    .yt-ai-launcher__spark {
      color: #8ab4f8;
      font-size: 14px;
      line-height: 1;
    }
  `;
  document.head.append(style);
}

function updateSidebarVisibility() {
  const isWatchPage = location.pathname === '/watch';

  // Keep the UI available on any watch page. Transcript loading already
  // reports unsupported videos inside the panel, and YouTube's live/premiere
  // markers are noisy enough to hide the UI on normal VOD pages.
  const isSupported = isWatchPage;

  if (ui.host) {
    ui.host.style.display = state.sidebarOpen && isSupported ? '' : 'none';
  }

  if (ui.launcher) {
    ui.launcher.style.display = isSupported ? 'inline-flex' : 'none';
    ui.launcher.classList.toggle('yt-ai-launcher--active', state.sidebarOpen);
    ui.launcher.setAttribute('aria-pressed', state.sidebarOpen ? 'true' : 'false');
  }
}

function openSidebar({ focus = false } = {}) {
  state.sidebarOpen = true;
  mountWhenReady();
  mountLauncherButton();
  updateSidebarVisibility();

  if (focus) {
    requestAnimationFrame(() => {
      ui.input?.focus();
    });
  }
}

function closeSidebar() {
  state.sidebarOpen = false;
  updateSidebarVisibility();
}

async function hydrateCurrentVideo() {
  const videoId = getVideoId();
  if (!videoId || videoId === state.currentVideoId) {
    return;
  }

  state.currentVideoId = videoId;
  clearActiveRequestTracking();
  state.activeRequestId = null;
  state.transcriptSegments = [];
  state.transcriptText = '';
  state.starterQuestions = [];
  state.startersDismissed = false;
  state.messages = [];
  state.pendingFrameContext = null;

  renderComposerFramePreview();
  renderMessages();
  renderStarters();
  updateStatus('Loading transcript...');
  updateTranscriptMeta('');

  try {
    const transcriptSegments = await fetchTranscript(videoId);
    state.transcriptSegments = transcriptSegments;
    state.transcriptText = transcriptSegments.map((segment) => `${segment.timestamp} ${segment.text}`).join('\n');
    state.transcriptStatus = 'Transcript ready';

    updateStatus(state.transcriptStatus);
    updateTranscriptMeta(`${transcriptSegments.length} timestamped transcript lines`);

    state.transcriptRequestId = crypto.randomUUID();
    void postToBackground({
      type: 'starter-questions',
      requestId: state.transcriptRequestId,
      title: getVideoTitle(),
      videoUrl: location.href,
      transcriptText: state.transcriptText
    }, { silent: true });
  } catch (error) {
    state.transcriptStatus = 'Transcript unavailable';
    state.messages = [
      {
        role: 'assistant',
        text: `I could not load a transcript for this video: ${error instanceof Error ? error.message : 'Unknown error'}`,
        sources: []
      }
    ];
    updateStatus(state.transcriptStatus);
    updateTranscriptMeta('This sidebar works best when captions are available.');
    renderMessages();
  }
}

async function sendChat(text, frameContext = null) {
  const requestId = crypto.randomUUID();
  const attachedFrame = frameContext ? { ...frameContext } : null;
  const chatMessage = {
    type: 'chat',
    requestId,
    title: getVideoTitle(),
    videoUrl: location.href,
    userMessage: text,
    frameContext: attachedFrame,
    transcriptText: state.transcriptText,
    transcriptStats: {
      status: state.transcriptStatus,
      segmentCount: state.transcriptSegments.length
    },
    history: state.messages.slice(0, -2).map((message) => ({
      role: message.role,
      text: message.text
    }))
  };

  state.activeRequestId = requestId;
  state.activeRequestPendingPayload = {
    message: chatMessage,
    requestId,
    retryCount: 0
  };
  state.activeRequestHasResponse = false;
  state.activeRequestStatusText = 'Preparing answer...';
  state.activeRequestReasoningActive = false;
  state.startersDismissed = true;
  state.starterQuestions = [];
  state.messages.push({ role: 'user', text: buildUserMessageText(text, attachedFrame), sources: [] });
  state.messages.push({ role: 'assistant', text: '', sources: [] });
  ui.input.value = '';
  state.pendingFrameContext = null;
  updateStatus(state.activeRequestStatusText);
  renderComposerFramePreview();
  renderStarters();
  renderMessages();

  try {
    await postToBackground(chatMessage);
    scheduleActiveRequestStartTimeout(requestId);
  } catch (error) {
    clearActiveRequestTracking();
    state.activeRequestId = null;
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role === 'assistant' && !lastMessage.text) {
      lastMessage.text = 'The request could not reach the background service. Please try again.';
    }
    updateStatus(error instanceof Error ? error.message : 'Background connection failed.');
    renderMessages();
  }
}

async function fetchTranscript(videoId) {
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (Array.isArray(transcript) && transcript.length > 0) {
      return transcript.map(normalizeTranscriptSegment);
    }
  } catch {
  }

  return fetchTranscriptFallback(videoId);
}

function normalizeTranscriptSegment(segment) {
  const rawOffset = Number(segment.offset ?? segment.start ?? 0);
  const seconds = rawOffset > 1000 ? rawOffset / 1000 : rawOffset;
  return {
    text: collapseWhitespace(segment.text || ''),
    seconds,
    timestamp: `[${formatTimestamp(seconds)}]`
  };
}

async function fetchTranscriptFallback(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  if (!response.ok) {
    throw new Error(`YouTube page fetch failed with ${response.status}`);
  }

  const html = await response.text();
  const tracks = extractCaptionTracks(html);
  if (!tracks.length) {
    throw new Error('No caption tracks were exposed for this video.');
  }

  const preferredTrack = tracks.find((track) => track.languageCode === 'en') || tracks[0];
  const vttUrl = `${preferredTrack.baseUrl}&fmt=vtt`;
  const vttResponse = await fetch(vttUrl);
  if (!vttResponse.ok) {
    throw new Error(`Caption fetch failed with ${vttResponse.status}`);
  }

  return parseVtt(await vttResponse.text());
}

function extractCaptionTracks(html) {
  const match = html.match(/"captionTracks":(\[[\s\S]*?\]),"audioTracks"/);
  if (!match) {
    return [];
  }

  try {
    const json = match[1]
      .replace(/\\u0026/g, '&')
      .replace(/\\"/g, '"');
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseVtt(vtt) {
  const lines = vtt.split(/\r?\n/);
  const segments = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.includes('-->')) {
      continue;
    }

    const start = line.split('-->')[0]?.trim();
    const nextLine = collapseWhitespace(lines[index + 1] || '');
    if (!nextLine) {
      continue;
    }

    const seconds = parseVttTime(start);
    segments.push({
      text: nextLine,
      seconds,
      timestamp: `[${formatTimestamp(seconds)}]`
    });
  }

  if (!segments.length) {
    throw new Error('Could not parse VTT captions.');
  }

  return segments;
}

function parseVttTime(value) {
  const parts = value.split(':').map((part) => part.trim());
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }

  return Number(parts[0]) * 60 + Number(parts[1]);
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderMessages() {
  if (!ui.messages) {
    return;
  }

  // Remove extra messages if state was cleared
  while (ui.messages.children.length > state.messages.length) {
    ui.messages.lastElementChild.remove();
  }

  for (let i = 0; i < state.messages.length; i++) {
    const message = state.messages[i];
    let article = ui.messages.children[i];

    if (!article) {
      article = document.createElement('article');
      article.className = `message message--${message.role}`;
      
      const body = document.createElement('div');
      body.className = message.role === 'user' ? 'message__prompt' : 'message__body';
      article.append(body);
      
      ui.messages.append(article);
    }

    const body = article.firstElementChild;
    let newHtml = '';
    let newText = '';

    if (message.role === 'user') {
      newText = message.text;
      if (body.textContent !== newText) {
        body.textContent = newText;
      }
    } else {
      const existingDetails = body.querySelector('details');
      const shouldOpenThinking = state.activeRequestReasoningOpen || (existingDetails ? existingDetails.open : false);

      if (!message.text && state.activeRequestId && i === state.messages.length - 1) {
        const statusText = escapeHtml(state.activeRequestStatusText || 'Working...');
        newHtml = `
          <div class="thinking-state">
            <div class="thinking-state__pulses">
              <span class="thinking-state__pulse"></span>
              <span class="thinking-state__pulse"></span>
              <span class="thinking-state__pulse"></span>
            </div>
            <span class="thinking-state__label">${statusText}</span>
          </div>
        `;
      } else {
        newHtml = renderMarkdown(message.text, message.sources || []);
        if (newHtml.includes('thinking-pill__preview')) {
          newHtml = injectThinkingPreview(newHtml, message.reasoningPreview || (state.activeRequestReasoningActive ? 'Thinking…' : ''));
        }
        if (newHtml.includes('<details')) {
          newHtml = newHtml.replace('<details class="thinking-pill">', shouldOpenThinking ? '<details open class="thinking-pill">' : '<details class="thinking-pill">');
        }
      }
      
      if (body.dataset.rawHtml !== newHtml) {
        body.innerHTML = newHtml;
        body.dataset.rawHtml = newHtml;

        const details = body.querySelector('details.thinking-pill');
        if (details) {
          details.open = shouldOpenThinking;
          details.addEventListener('toggle', () => {
            if (state.activeRequestId) {
              state.activeRequestReasoningOpen = details.open;
            }
          });
        }
      }
    }

    let sourceRow = article.querySelector('.message__sources');
    if (message.sources?.length) {
      if (!sourceRow) {
        sourceRow = document.createElement('div');
        sourceRow.className = 'message__sources';
        article.append(sourceRow);
      }
      
      // Only update sources if they changed 
      // (simple check by length or stringified JSON)
      const sourcesJson = JSON.stringify(message.sources);
      if (sourceRow.dataset.sourcesJson !== sourcesJson) {
        sourceRow.innerHTML = '';
        for (const source of message.sources) {
          const link = document.createElement('a');
          link.className = 'source-link';
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.innerHTML = `<img src="${source.faviconUrl}" alt="" /><span>[${source.id}] ${escapeHtml(source.title)}</span>`;
          sourceRow.append(link);
        }
        sourceRow.dataset.sourcesJson = sourcesJson;
      }
    } else if (sourceRow) {
      sourceRow.remove();
    }
  }

  const scrollContainer = ui.conversation || ui.messages;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

function renderStarters() {
  if (!ui.starters) {
    return;
  }

  ui.starters.innerHTML = '';

  if (state.startersDismissed) {
    return;
  }

  const starterQuestions = [DEFAULT_STARTER_QUESTION, ...state.starterQuestions].filter((question, index, allQuestions) => {
    const normalizedQuestion = collapseWhitespace(question).toLowerCase();
    return normalizedQuestion && allQuestions.findIndex((candidate) => collapseWhitespace(candidate).toLowerCase() === normalizedQuestion) === index;
  });

  if (!state.starterQuestions.length) {
    const summaryButton = document.createElement('button');
    summaryButton.type = 'button';
    summaryButton.className = 'starter-chip';
    summaryButton.textContent = DEFAULT_STARTER_QUESTION;
    summaryButton.addEventListener('click', () => {
      if (state.activeRequestId) {
        return;
      }
      sendChat(DEFAULT_STARTER_QUESTION, state.pendingFrameContext);
    });
    ui.starters.append(summaryButton);

    const placeholder = document.createElement('p');
    placeholder.className = 'starter-placeholder';
    placeholder.textContent = state.transcriptText ? 'Generating starter questions...' : 'Starter questions appear after the transcript loads.';
    ui.starters.append(placeholder);
    return;
  }

  for (const question of starterQuestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'starter-chip';
    button.textContent = question;
    button.addEventListener('click', () => {
      if (state.activeRequestId) {
        return;
      }
      sendChat(question, state.pendingFrameContext);
    });
    ui.starters.append(button);
  }
}

function renderMarkdown(text, sources) {
  const sourceMap = new Map((sources || []).map((source) => [String(source.id), source]));
  let html = DOMPurify.sanitize(marked.parse(text || ''));

  html = html.replace(/\[(\d+)\]|【(\d+)】/g, (match, squareId, fullWidthId) => {
    const id = squareId || fullWidthId;
    const source = sourceMap.get(id);
    if (!source) {
      return match;
    }

    return `<a class="citation-pill" href="${source.url}" target="_blank" rel="noreferrer"><img src="${source.faviconUrl}" alt="" /><span>${id}</span></a>`;
  });

  return wrapMarkdownTables(linkifyTimestamps(html));
}

function injectThinkingPreview(html, previewText) {
  const summaryText = summarizeThinkingPreview(previewText || '');
  if (!summaryText) {
    return html.replace('<span class="thinking-pill__preview"></span>', '');
  }

  const rendered = renderMarkdown(summaryText);
  return html.replace(
    '<span class="thinking-pill__preview"></span>',
    `<span class="thinking-pill__preview"><span class="thinking-pill__preview-text">${rendered}</span></span>`
  );
}

function summarizeThinkingPreview(text) {
  const target = String(text || '').trim();
  if (target.length < 800) {
    return target;
  }
  const sliceIndex = target.lastIndexOf('\n\n', target.length - 400);
  const start = sliceIndex >= 0 ? sliceIndex + 2 : target.length - 400;
  return '...\n\n' + target.slice(start);
}

function wrapMarkdownTables(html) {
  const container = document.createElement('div');
  container.innerHTML = html;

  for (const table of container.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-scroll')) {
      continue;
    }

    table.classList.add('message-table');

    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }

  return container.innerHTML;
}

function linkifyTimestamps(html) {
  const container = document.createElement('div');
  container.innerHTML = html;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  const regex = /(?:\[|【)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\]|】)?/g;

  for (const textNode of textNodes) {
    // Skip if it's already inside a link or a code block
    if (textNode.parentNode && (textNode.parentNode.nodeName === 'A' || textNode.parentNode.nodeName === 'CODE' || textNode.parentNode.nodeName === 'PRE')) {
      continue;
    }

    const text = textNode.nodeValue;
    if (!regex.test(text)) {
      continue;
    }

    regex.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const label = match[1];
      const seconds = timestampLabelToSeconds(label);
      
      if (seconds !== null) {
        if (match.index > lastIndex) {
          fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const link = document.createElement('a');
        link.className = 'timestamp-link';
        link.href = buildTimestampHref(seconds);
        link.dataset.seekSeconds = seconds;
        link.title = `Jump to ${label}`;
        link.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px;vertical-align:text-bottom;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>${label}`;
        
        fragment.append(link);
        lastIndex = regex.lastIndex;
      }
    }

    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }

    if (fragment.childNodes.length > 0) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  return container.innerHTML;
}

function timestampLabelToSeconds(label) {
  const parts = String(label || '').split(':').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

function buildTimestampHref(seconds) {
  const url = new URL(location.href);
  url.searchParams.set('t', `${Math.max(0, Math.floor(seconds))}`);
  return url.toString();
}

function seekToTimestamp(seconds) {
  const video = document.querySelector('video');
  if (!video) {
    return false;
  }

  video.currentTime = Math.max(0, seconds);
  const url = new URL(location.href);
  url.searchParams.set('t', `${Math.max(0, Math.floor(seconds))}`);
  history.replaceState(history.state, '', url.toString());
  return true;
}

function updateStatus(text) {
  if (ui.status) {
    ui.status.textContent = text;
  }
}

function updateTranscriptMeta(text) {
  if (ui.transcriptMeta) {
    ui.transcriptMeta.textContent = text;
  }
}

function getVideoId() {
  const url = new URL(location.href);
  if (url.pathname !== '/watch') {
    return '';
  }

  return url.searchParams.get('v') || '';
}

function getVideoTitle() {
  const titleElement = document.querySelector('ytd-watch-metadata h1 yt-formatted-string') || document.querySelector('h1.title');
  return collapseWhitespace(titleElement?.textContent || document.title.replace(/ - YouTube$/, ''));
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildShell() {
  return `
    <style>
      :host {
        color-scheme: dark;
        --panel-bg: #0f0f0f;
        --panel-elevated: #0f0f0f;
        --panel-soft: rgba(255, 255, 255, 0.04);
        --panel-hover: rgba(255, 255, 255, 0.08);
        --line: rgba(255, 255, 255, 0.1);
        --line-soft: rgba(255, 255, 255, 0.05);
        --text: #f1f1f1;
        --text-muted: #aaa;
        --text-faint: #717171;
        --accent: #fff;
        --user-bg: #282828;
        --user-border: transparent;
        --model-bg: transparent;
        --model-border: transparent;
        font-family: "YouTube Sans", Roboto, Arial, sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      button,
      textarea {
        font: inherit;
      }

      .panel {
        position: sticky;
        top: 8px;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 16px;
        height: calc(100vh - 88px);
        max-height: calc(100vh - 88px);
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--panel-bg);
        overflow: hidden;
      }

      .header,
      .meta,
      .composer {
        position: relative;
      }

      .header {
        z-index: 4;
      }

      .meta,
      .messages,
      .composer {
        z-index: 1;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 8px;
        margin: 0;
      }

      .header__actions {
        display: flex;
        align-items: center;
        gap: 8px;
        position: relative;
      }

      .header h2 {
        display: block;
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.2px;
        line-height: 1.2;
        color: var(--text);
      }

      .header button {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-soft);
        color: var(--text-muted);
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .header button:hover {
        background: var(--panel-hover);
        color: var(--text);
        border-color: var(--line);
      }

      .header__close {
        width: 32px;
        height: 32px;
        padding: 0;
        font-size: 20px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .header__model-button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        max-width: 188px;
        padding-right: 12px;
      }

      .header__model-button svg:last-child {
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        margin-left: 2px;
        transition: transform 150ms ease;
      }

      .header__model-button--open svg:last-child {
        transform: rotate(180deg);
      }

      .header__model-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .model-picker {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: min(100%, 320px);
        max-width: calc(100vw - 56px);
        z-index: 24;
      }

      .model-picker__surface {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(15, 15, 15, 0.98);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
      }

      .model-picker__toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }

      .model-picker__search {
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.03);
        color: var(--text);
        padding: 10px 12px;
        outline: none;
      }

      .model-picker__search:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px rgba(163, 194, 255, 0.25);
      }

      .model-picker__refresh {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel-soft);
        color: var(--text-muted);
        padding: 0 12px;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .model-picker__refresh:hover {
        background: var(--panel-hover);
        color: var(--text);
      }

      .model-picker__list {
        display: grid;
        gap: 2px;
        max-height: 380px;
        overflow-y: auto;
        padding-right: 4px;
      }

      .model-picker__empty,
      .model-picker__group-note {
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .model-picker__group {
        display: grid;
        gap: 2px;
        padding: 8px 4px 10px;
        border: 0;
        border-bottom: 1px solid var(--line-soft);
        border-radius: 0;
        background: transparent;
      }

      .model-picker__group--active {
        background: transparent;
      }

      .model-picker__group-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        padding: 0 8px 6px;
      }

      .model-picker__group-header strong {
        color: var(--text);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .model-picker__group-header span {
        color: var(--text-faint);
        font-size: 11px;
      }

      .model-option {
        display: grid;
        gap: 3px;
        width: 100%;
        padding: 10px 12px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--text-muted);
        text-align: left;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .model-option:hover {
        background: rgba(255, 255, 255, 0.05);
        color: var(--text);
      }

      .model-option--active {
        background: rgba(255, 255, 255, 0.08);
        color: var(--text);
      }

      .model-option__title {
        font-size: 13px;
        font-weight: 600;
      }

      .model-option__id {
        color: var(--text-faint);
        font-size: 11px;
        line-height: 1.35;
        word-break: break-all;
      }

      .model-option__meta {
        color: var(--text-muted);
        font-size: 11px;
      }

      .meta {
        display: grid;
        gap: 8px;
      }

      .meta strong {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }

      .meta p {
        margin: 0;
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .starters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .starter-chip {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-soft);
        color: var(--text-muted);
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .starter-chip:hover {
        background: var(--panel-hover);
        color: var(--text);
        border-color: rgba(255, 255, 255, 0.2);
        transform: translateY(-1px);
      }

      .starter-placeholder {
        margin: 0;
        color: var(--text-faint);
        font-size: 12px;
        font-style: italic;
      }

      .conversation {
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 14px;
        flex: 1 1 auto;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 0 8px 16px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.1) transparent;
        scrollbar-gutter: stable;
      }

      .assistant-intro {
        text-align: center;
        padding: 32px 16px 8px;
        color: var(--text);
        flex-shrink: 0;
      }

      .assistant-intro__sparkle {
        width: 32px;
        height: 32px;
        color: var(--accent);
        margin-bottom: 16px;
      }

      .assistant-intro p:not(.assistant-intro__sub) {
        font-size: 24px;
        line-height: 1.3;
        font-weight: 500;
        margin: 0 0 12px 0;
      }

      .assistant-intro__sub {
        font-size: 14px;
        color: var(--text-muted);
        margin: 0;
      }

      .messages {
        position: relative;
        z-index: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 4px 0 0;
      }

      .message {
        display: grid;
        gap: 8px;
        min-width: 0;
        animation: fadeIn 0.3s ease-out forwards;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .message--assistant {
        min-width: 0;
        background: transparent;
        border: none;
        border-radius: 0;
        padding: 4px 0 16px 0;
        box-shadow: none;
      }

      .message--user {
        justify-items: end;
        padding: 0 0 16px 0;
        background: transparent;
        border: 0;
      }

      .message__prompt {
        max-width: 85%;
        border: none;
        border-radius: 18px;
        background: var(--user-bg);
        color: var(--text);
        padding: 12px 16px;
        font-size: 15px;
        line-height: 1.45;
        box-shadow: none;
      }

      .message__body {
        min-width: 0;
        max-width: 100%;
        color: var(--text);
        font-size: 15px;
        line-height: 1.6;
      }

      .message__body p,
      .message__body ul,
      .message__body ol,
      .message__body blockquote {
        margin: 0 0 12px;
      }

      .message__body p:last-child,
      .message__body ul:last-child,
      .message__body ol:last-child,
      .message__body blockquote:last-child {
        margin-bottom: 0;
      }

      .message__body code {
        background: rgba(255,255,255,0.1);
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 13px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      .message__body pre {
        overflow-x: auto;
        padding: 12px;
        border-radius: 8px;
        background: rgba(0,0,0,0.4);
        border: 1px solid var(--line-soft);
        margin: 12px 0;
      }

      .table-scroll {
        display: block;
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        margin: 12px 0;
        border: 1px solid var(--line-soft);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.02);
      }

      .message-table {
        width: 100%;
        min-width: 100%;
        table-layout: fixed;
        border-collapse: separate;
        border-spacing: 0;
      }

      .message-table th,
      .message-table td {
        padding: 10px 12px;
        text-align: left;
        vertical-align: top;
        border-right: 1px solid var(--line-soft);
        border-bottom: 1px solid var(--line-soft);
        overflow-wrap: anywhere;
        word-break: break-word;
        hyphens: auto;
      }

      .message-table th:last-child,
      .message-table td:last-child {
        border-right: 0;
      }

      .message-table tr:last-child td {
        border-bottom: 0;
      }

      .message-table thead th {
        position: sticky;
        top: 0;
        z-index: 2;
        background: rgba(18, 18, 18, 0.96);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }

      .message-table tbody tr:nth-child(even) td {
        background: rgba(255, 255, 255, 0.02);
      }

      .message__sources {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed var(--line-soft);
      }

      .source-link,
      .citation-pill,
      .timestamp-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-soft);
        padding: 4px 10px;
        color: var(--text-muted);
        font-size: 12px;
        font-weight: 500;
        text-decoration: none;
        transition: all 150ms ease;
      }

      .source-link:hover,
      .citation-pill:hover,
      .timestamp-link:hover {
        background: var(--panel-hover);
        color: var(--text);
        border-color: rgba(255, 255, 255, 0.2);
      }

      .timestamp-link {
        gap: 4px;
        margin: 0 2px;
        padding: 2px 8px;
        border-color: rgba(163, 194, 255, 0.3);
        background: rgba(163, 194, 255, 0.1);
        color: var(--accent);
        border-radius: 4px;
      }
      
      .timestamp-link:hover {
        background: rgba(163, 194, 255, 0.2);
        color: #fff;
        border-color: var(--accent);
      }

      .source-link img,
      .citation-pill img {
        width: 14px;
        height: 14px;
        border-radius: 4px;
      }

      .thinking-state {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 4px;
      }

      .thinking-state__pulses {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }

      .thinking-state__pulse {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--accent);
        animation: pulse 1.4s infinite ease-in-out both;
      }

      .thinking-state__pulse:nth-child(1) { animation-delay: -0.32s; }
      .thinking-state__pulse:nth-child(2) { animation-delay: -0.16s; }

      .thinking-state__label {
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .thinking-pill {
        display: block;
        margin: 2px 0 10px;
        border: 1px solid rgba(163, 194, 255, 0.22);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.03);
        overflow: hidden;
      }

      .thinking-pill > summary {
        display: grid;
        grid-template-columns: 1fr;
        gap: 4px;
        padding: 10px 12px;
        cursor: pointer;
        list-style: none;
        user-select: none;
      }

      .thinking-pill > summary::-webkit-details-marker {
        display: none;
      }

      .thinking-pill__label {
        display: block;
        color: var(--accent);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .thinking-pill__preview {
        display: flex;
        flex-direction: column-reverse;
        min-width: 0;
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.4;
        height: calc(2 * 1.4em);
        overflow: hidden;
        mask-image: linear-gradient(to bottom, transparent 0%, black 1.2em);
        -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 1.2em);
      }

      .thinking-pill__preview-text {
        white-space: normal;
        word-wrap: break-word;
      }

      .thinking-pill__preview-text p,
      .thinking-pill__preview-text ul,
      .thinking-pill__preview-text ol,
      .thinking-pill__preview-text blockquote {
        margin: 0;
      }

      .thinking-pill__preview-text pre {
        margin: 0;
        padding: 0;
        background: transparent;
        border: none;
      }

      .thinking-pill__body {
        padding: 0 12px 12px;
        border-top: 1px solid var(--line-soft);
        color: var(--text);
        font-size: 13px;
        line-height: 1.55;
      }

      .thinking-pill[open] {
        background: rgba(163, 194, 255, 0.06);
      }

      .thinking-pill[open] > summary {
        border-bottom: 1px solid var(--line-soft);
      }

      @keyframes pulse {
        0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
        40% { transform: scale(1); opacity: 1; }
      }

      .composer {
        display: grid;
        gap: 12px;
        padding: 12px 16px;
        background: #1e1f20;
        border-radius: 24px;
        box-shadow: none;
      }

      .composer textarea {
        width: 100%;
        min-height: 48px;
        max-height: 200px;
        background: transparent;
        border: none;
        color: var(--text);
        resize: none;
        padding: 0;
        margin: 0;
        outline: none;
        font-size: 16px;
        line-height: 1.5;
      }
      .composer textarea::placeholder {
        color: var(--text-muted);
        font-size: 16px;
      }

      .disclaimer {
        text-align: center;
        font-size: 11px;
        color: var(--text-faint);
        margin-top: 8px;
        padding-bottom: 4px;
      }
      .disclaimer a {
        color: var(--text-faint);
        text-decoration: underline;
      }

      .composer__attachments {
        display: grid;
        gap: 8px;
      }

      .composer__tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .composer__tool {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(163, 194, 255, 0.2);
        border-radius: 999px;
        padding: 7px 12px;
        background: rgba(163, 194, 255, 0.08);
        color: var(--accent);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .composer__tool:hover {
        background: rgba(163, 194, 255, 0.16);
        border-color: rgba(163, 194, 255, 0.35);
        color: #fff;
      }

      .frame-chip {
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.03);
      }

      .frame-chip__thumb {
        width: 72px;
        height: 48px;
        object-fit: cover;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .frame-chip__meta {
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .frame-chip__meta strong {
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
      }

      .frame-chip__meta span {
        color: var(--text-muted);
        font-size: 11px;
      }

      .frame-chip__remove {
        width: 28px;
        height: 28px;
        border: 1px solid var(--line);
        border-radius: 50%;
        background: var(--panel-soft);
        color: var(--text-muted);
        cursor: pointer;
        transition: all 150ms ease;
      }

      .frame-chip__remove:hover {
        background: var(--panel-hover);
        color: var(--text);
      }

      .composer__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .composer__hint {
        color: var(--text-faint);
        font-size: 11px;
      }

      .send {
        background: transparent;
        color: #fff;
        border: none;
        padding: 6px;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .send:hover {
        transform: translateY(-1px);
        color: var(--accent);
      }

      .send svg {
        width: 20px;
        height: 20px;
      }

      @media (max-width: 1100px) {
        .panel {
          height: 640px;
          max-height: 640px;
        }
      }
    </style>
    <section class="panel">
      <header class="header">
        <div class="header__actions">
          <button type="button" class="header__model-button" data-action="toggle-model-picker" aria-haspopup="dialog" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"></path><path d="M3 12h18"></path><circle cx="12" cy="12" r="9"></circle></svg>
            <span class="header__model-label" data-role="model-picker-label">Choose model</span>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <button type="button" data-action="new-chat" title="New Chat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="12" y1="8" x2="12" y2="14"></line><line x1="9" y1="11" x2="15" y2="11"></line></svg>
          </button>
          <button type="button" data-action="options" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <button type="button" class="header__close" data-action="close" aria-label="Close AI panel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <div class="model-picker" data-role="model-picker-panel" hidden></div>
        </div>
      </header>
      <section class="conversation">
        <div class="assistant-intro">
          <svg class="assistant-intro__sparkle" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"></path></svg>
          <p>I can break down the video, pull out key points, or answer questions as you watch.</p>
          <p class="assistant-intro__sub">Try one of these to get started.</p>
        </div>
        <div class="starters" data-role="starters"></div>
        <div class="messages" data-role="messages"></div>
      </section>
      <form class="composer">
        <textarea placeholder="Ask a question..."></textarea>
        <div class="composer__attachments" data-role="frame-preview" hidden></div>
        <div class="composer__footer">
          <div class="composer__tools">
            <button class="composer__tool" type="button" data-action="capture-frame">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
              <span data-role="frame-button-label">Use current frame</span>
            </button>
          </div>
          <button class="send" type="submit" aria-label="Send">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
      </form>
    </section>
    <div class="disclaimer">AI can make mistakes, so double-check it. <a href="https://gemini.google.com/" target="_blank">Learn more</a></div>
  `;
}

function applyResponsiveSidebarWidth() {
  if (!ui.host) {
    return;
  }

  const containerWidth = ui.secondaryInner?.clientWidth || ui.host.parentElement?.clientWidth || 0;
  const viewportWidth = window.innerWidth;
  const availableWidth = Math.max(0, Math.min(containerWidth || viewportWidth, viewportWidth - 40));
  ui.host.style.boxSizing = 'border-box';
  ui.host.style.maxWidth = '100%';

  if (availableWidth <= 0) {
    ui.host.style.width = '';
    return;
  }

  const horizontalInset = availableWidth >= 440 ? 18 : 10;
  const desiredWidth = Math.round(Math.min(520, Math.max(320, availableWidth - horizontalInset)));
  ui.host.style.width = `${Math.min(desiredWidth, availableWidth)}px`;
}