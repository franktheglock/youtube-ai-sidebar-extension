import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { YoutubeTranscript } from 'youtube-transcript';

const HOST_ID = 'yt-ai-sidebar-host';
const LAUNCHER_ID = 'yt-ai-sidebar-launcher';
const LAUNCHER_STYLE_ID = 'yt-ai-sidebar-launcher-style';
const PANEL_TITLE = 'Ask This Video';
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
  transcriptRequestId: null
};

const ui = {
  shadow: null,
  host: null,
  secondaryInner: null,
  secondaryResizeObserver: null,
  panel: null,
  status: null,
  transcriptMeta: null,
  starters: null,
  messages: null,
  form: null,
  input: null,
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
    clearActiveRequestTracking();
    state.activeRequestId = null;
    updateStatus('Ready');
    renderMessages();
    return;
  }

  if (message.type === 'assistant-error') {
    clearActiveRequestTracking();
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
  ui.status = ui.shadow.querySelector('[data-role="status"]');
  ui.transcriptMeta = ui.shadow.querySelector('[data-role="transcript-meta"]');
  ui.starters = ui.shadow.querySelector('[data-role="starters"]');
  ui.messages = ui.shadow.querySelector('[data-role="messages"]');
  ui.form = ui.shadow.querySelector('form');
  ui.input = ui.shadow.querySelector('textarea');
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

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.input.value.trim();
    if (!value || state.activeRequestId) {
      return;
    }
    sendChat(value);
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
      openSidebar({ focus: true });
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

async function sendChat(text) {
  const requestId = crypto.randomUUID();
  const chatMessage = {
    type: 'chat',
    requestId,
    title: getVideoTitle(),
    videoUrl: location.href,
    userMessage: text,
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
  state.startersDismissed = true;
  state.starterQuestions = [];
  state.messages.push({ role: 'user', text, sources: [] });
  state.messages.push({ role: 'assistant', text: '', sources: [] });
  ui.input.value = '';
  updateStatus(state.activeRequestStatusText);
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
      }
      
      if (body.dataset.rawHtml !== newHtml) {
        body.innerHTML = newHtml;
        body.dataset.rawHtml = newHtml;
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

  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function renderStarters() {
  if (!ui.starters) {
    return;
  }

  ui.starters.innerHTML = '';

  if (state.startersDismissed) {
    return;
  }

  if (!state.starterQuestions.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'starter-placeholder';
    placeholder.textContent = state.transcriptText ? 'Generating starter questions...' : 'Starter questions appear after the transcript loads.';
    ui.starters.append(placeholder);
    return;
  }

  for (const question of state.starterQuestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'starter-chip';
    button.textContent = question;
    button.addEventListener('click', () => {
      if (state.activeRequestId) {
        return;
      }
      sendChat(question);
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
  state.transcriptStatus = text;
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
        --panel-bg: rgba(18, 18, 18, 0.7);
        --panel-elevated: rgba(28, 28, 28, 0.4);
        --panel-soft: rgba(255, 255, 255, 0.04);
        --panel-hover: rgba(255, 255, 255, 0.08);
        --line: rgba(255, 255, 255, 0.1);
        --line-soft: rgba(255, 255, 255, 0.05);
        --text: #fdfdfd;
        --text-muted: #bababa;
        --text-faint: #818181;
        --accent: #a3c2ff;
        --user-bg: linear-gradient(135deg, #1d3557, #16263a);
        --user-border: rgba(163, 194, 255, 0.15);
        --model-bg: rgba(255, 255, 255, 0.02);
        --model-border: rgba(255, 255, 255, 0.06);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
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
        grid-template-rows: auto auto minmax(0, 1fr) auto;
        gap: 16px;
        height: calc(100vh - 88px);
        max-height: calc(100vh - 88px);
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 20px;
        background: var(--panel-bg);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.06);
        overflow: hidden;
      }

      .header,
      .meta,
      .composer {
        position: relative;
        z-index: 1;
      }

      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--line-soft);
      }

      .header__actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .header__eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted);
      }

      .header__eyebrow::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 8px var(--accent);
      }

      .header h2 {
        margin: 4px 0 0;
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

      .messages {
        position: relative;
        z-index: 1;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 4px 8px 16px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.1) transparent;
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
        background: var(--model-bg);
        border: 1px solid var(--model-border);
        border-radius: 6px 16px 16px 16px;
        padding: 14px 16px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      }

      .message--user {
        justify-items: end;
        padding: 0;
        background: transparent;
        border: 0;
      }

      .message__prompt {
        max-width: 85%;
        border: 1px solid var(--user-border);
        border-radius: 16px 6px 16px 16px;
        background: var(--user-bg);
        color: #fff;
        padding: 12px 16px;
        font-size: 14px;
        line-height: 1.45;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      }

      .message__body {
        min-width: 0;
        max-width: 100%;
        color: var(--text);
        font-size: 14px;
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
        width: max-content;
        min-width: 100%;
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

      @keyframes pulse {
        0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
        40% { transform: scale(1); opacity: 1; }
      }

      .composer {
        display: grid;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--line-soft);
      }

      textarea {
        width: 100%;
        min-height: 52px;
        max-height: 180px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(0,0,0,0.2);
        color: var(--text);
        padding: 14px 16px;
        outline: none;
        font-size: 14px;
        line-height: 1.5;
        transition: all 200ms ease;
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
      }

      textarea::placeholder {
        color: var(--text-faint);
      }

      textarea:focus {
        border-color: var(--accent);
        background: rgba(0,0,0,0.3);
        box-shadow: 0 0 0 1px rgba(163, 194, 255, 0.2), inset 0 2px 4px rgba(0,0,0,0.2);
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
        border: 1px solid rgba(163, 194, 255, 0.3);
        border-radius: 8px;
        padding: 8px 16px;
        background: rgba(163, 194, 255, 0.1);
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .send:hover {
        background: rgba(163, 194, 255, 0.2);
        color: #fff;
        border-color: var(--accent);
        transform: translateY(-1px);
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
        <div>
          <div class="header__eyebrow">AI Video Assistant</div>
          <h2>${PANEL_TITLE}</h2>
        </div>
        <div class="header__actions">
          <button type="button" data-action="options" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <button type="button" class="header__close" data-action="close" aria-label="Close AI panel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </header>
      <section class="meta">
        <strong data-role="status">Waiting for a YouTube video</strong>
        <p data-role="transcript-meta"></p>
        <div class="starters" data-role="starters"></div>
      </section>
      <section class="messages" data-role="messages"></section>
      <form class="composer">
        <textarea placeholder="Ask a question about this video..."></textarea>
        <div class="composer__footer">
          <span class="composer__hint">Enter to send, Shift+Enter for newline</span>
          <button class="send" type="submit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: text-bottom;"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            Send
          </button>
        </div>
      </form>
    </section>
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