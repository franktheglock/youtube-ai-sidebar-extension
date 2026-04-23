
const DEFAULT_SETTINGS = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  openrouterApiKey: '',
  lmStudioBaseUrl: 'http://127.0.0.1:1234/v1',
  nvidiaNimBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nvidiaNimApiKey: '',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  searchProvider: 'duckduckgo',
  searxngBaseUrl: 'http://192.168.1.70:8888',
  temperature: 0.7,
  disableAutoQuestions: false
};

// ── Transformers.js: static model catalog ──────────────────────────────────────
const TRANSFORMERS_JS_MODELS = [
  {
    id: 'onnx-community/Qwen3.5-2B-ONNX',
    name: 'Qwen 3.5 2B',
    ownedBy: 'Alibaba / onnx-community',
    contextLength: 32768
  },
  {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    name: 'Gemma 4 E2B',
    ownedBy: 'Google / onnx-community',
    contextLength: 32768
  },
  {
    id: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    name: 'LFM 2.5 1.2B',
    ownedBy: 'Liquid AI',
    contextLength: 32768
  }
];

// Cache the loaded pipeline so we don't reload on every message
let _tjsOffscreenReady = false;

const portState = new WeakMap();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'capture-visible-tab') {
    chrome.tabs.captureVisibleTab(sender?.tab?.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      if (typeof dataUrl !== 'string' || !dataUrl) {
        sendResponse({ ok: false, error: 'Visible tab capture returned no image.' });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    });

    return true;
  }

  if (message?.type === 'get-model-catalog') {
    void handleGetModelCatalog(sendResponse);
    return true;
  }

  if (message?.type === 'set-active-model') {
    void handleSetActiveModel(message, sendResponse);
    return true;
  }

  if (message?.type === 'tjs-model-cached') {
    // Track which models have been downloaded
    chrome.storage.local.get({ tjsCachedModels: {} }, (data) => {
      const cached = data.tjsCachedModels || {};
      cached[message.modelId] = { cachedAt: Date.now() };
      chrome.storage.local.set({ tjsCachedModels: cached });
    });
    return false;
  }

  if (message?.type === 'tjs-check-cache') {
    void (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage(message);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Cache check failed.' });
      }
    })();
    return true;
  }

  if (message?.type === 'tjs-delete-model') {
    void (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage(message);
        
        // Clear from local storage tracking as well
        if (result?.ok) {
          chrome.storage.local.get({ tjsCachedModels: {} }, (data) => {
            const cached = data.tjsCachedModels || {};
            delete cached[message.modelId];
            chrome.storage.local.set({ tjsCachedModels: cached });
          });
        }
        
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Model deletion failed.' });
      }
    })();
    return true;
  }

  if (message?.type === 'tjs-download-model') {
    void (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage(message);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Model download failed.' });
      }
    })();
    return true;
  }

  if (message?.type !== 'open-options-page') {
    return false;
  }

  chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    sendResponse({ ok: true });
  });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'yt-ai-sidebar') {
    return;
  }

  portState.set(port, { controller: null });

  port.onDisconnect.addListener(() => {
    const state = portState.get(port);
    state?.controller?.abort();
    portState.delete(port);
  });

  port.onMessage.addListener((message) => {
    if (message?.type === 'chat') {
      void handleChat(port, message);
      return;
    }

    if (message?.type === 'starter-questions') {
      void handleStarterQuestions(port, message);
      return;
    }

    if (message?.type === 'cancel') {
      const state = portState.get(port);
      state?.controller?.abort();
    }
  });
});

async function handleChat(port, message) {
  const state = portState.get(port);
  state?.controller?.abort();
  state.controller = new AbortController();

  port.postMessage({
    type: 'assistant-started',
    requestId: message.requestId
  });

  try {
    const settings = await getSettings();
    const provider = getProviderConfig(settings);
    let finalSources = [];
    const baseMessages = buildAnswerMessages({
      title: message.title,
      videoUrl: message.videoUrl,
      transcriptText: message.transcriptText,
      transcriptStats: message.transcriptStats,
      history: message.history,
      userMessage: message.userMessage,
      frameContext: message.frameContext,
      toolMessages: []
    });

    if (provider.kind === 'transformers-js') {
      await transformersJsGenerate({
        modelId: provider.model,
        messages: baseMessages,
        signal: state.controller.signal,
        temperature: settings.temperature,
        port,
        requestId: message.requestId,
        onChunk: (chunk) => {
          port.postMessage({
            type: 'assistant-chunk',
            requestId: message.requestId,
            chunk
          });
        }
      });
    } else if (supportsToolCalling(provider)) {
      sendAssistantStatus(port, message.requestId, 'Generating answer...');
      const result = await streamChatWithTools({
        provider,
        settings,
        port,
        requestId: message.requestId,
        messages: baseMessages,
        signal: state.controller.signal,
        temperature: settings.temperature,
        onChunk: (chunk) => {
          port.postMessage({
            type: 'assistant-chunk',
            requestId: message.requestId,
            chunk
          });
        }
      });
      finalSources = result.sources;

      port.postMessage({
        type: 'sources',
        requestId: message.requestId,
        sources: result.sources
      });
    } else {
      sendAssistantStatus(port, message.requestId, 'Generating answer...');
      await streamChatCompletion({
        provider,
        messages: baseMessages,
        signal: state.controller.signal,
        temperature: settings.temperature,
        onChunk: (chunk) => {
          port.postMessage({
            type: 'assistant-chunk',
            requestId: message.requestId,
            chunk
          });
        }
      });
    }

    port.postMessage({
      type: 'assistant-done',
      requestId: message.requestId,
      sources: finalSources
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      port.postMessage({ type: 'assistant-cancelled', requestId: message.requestId });
      return;
    }

    port.postMessage({
      type: 'assistant-error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleStarterQuestions(port, message) {
  const state = portState.get(port);
  state?.controller?.abort();
  state.controller = new AbortController();

  try {
    const settings = await getSettings();
    const provider = getProviderConfig(settings);
    const prompt = [
      {
        role: 'system',
        content: [
          'You generate starter questions for an AI chat about a YouTube video.',
          'Return JSON only in the form {"questions":["...","...","..."]}.',
          'Rules:',
          '- Exactly 3 questions.',
          '- Each question should be 4 to 12 words.',
          '- Make them concrete and answerable from the transcript.',
          '- Avoid generic phrasing like "What is this video about?" unless the transcript is too thin.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `Title: ${message.title}`,
          `URL: ${message.videoUrl}`,
          `Transcript sample:\n${message.transcriptText.slice(0, 12000)}`
        ].join('\n\n')
      }
    ];

    let raw;
    if (provider.kind === 'transformers-js') {
      let accumulated = '';
      await transformersJsGenerate({
        modelId: provider.model,
        messages: prompt,
        signal: state.controller.signal,
        temperature: 0.3,
        port,
        requestId: message.requestId,
        onChunk: (chunk) => { accumulated += chunk; }
      });
      raw = accumulated;
    } else {
      raw = await completeChatCompletion({
        provider,
        messages: prompt,
        signal: state.controller.signal,
        temperature: 0.3
      });
    }

    const parsed = safeJsonParse(extractJsonBlock(raw));
    const questions = Array.isArray(parsed?.questions)
      ? parsed.questions.filter((entry) => typeof entry === 'string').slice(0, 3)
      : [];

    port.postMessage({
      type: 'starter-questions-result',
      requestId: message.requestId,
      questions: questions.length === 3 ? questions : buildFallbackQuestions(message.title)
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }

    port.postMessage({
      type: 'starter-questions-result',
      requestId: message.requestId,
      questions: buildFallbackQuestions(message.title)
    });
  }
}

function buildAnswerMessages({ title, videoUrl, transcriptText, transcriptStats, history, userMessage, frameContext, toolMessages }) {
  return [
    {
      role: 'system',
      content: [
        'You are an AI assistant embedded beside a YouTube video.',
        'Available tools: web_search(query) to search the public web, and read_url(url) to open a specific URL.',
        'Use tools whenever the user asks about current facts, historical facts, outside context, or comparisons that are not contained in the transcript.',
        'If a tool is needed, do not answer from the transcript alone.',
        'Answer with concise Markdown.',
        'Avoid Markdown tables unless they are absolutely necessary for clarity; prefer short paragraphs or bullet lists.',
        'Ground claims in the provided transcript whenever possible.',
        'When using transcript evidence, cite timestamps inline like [03:12] or [1:02:09].',
        'When using web/tool evidence, cite only with the provided numeric source markers like [1] and [2].',
        'If the latest user turn includes an attached video frame image, treat it as additional visual context from the current point in the video.',
        'Do not invent citations or timestamps.',
        'If the transcript is incomplete or unavailable, say so plainly.',
        'If the user asks for outside context, you may rely on tool results already provided.',
        'Keep answers specific to the current video unless the user asks otherwise.',
        'do not overly use the tool results, only use them when the question explicitly requires information that is not in the video transcript.'
      ].join('\n')
    },
    {
      role: 'system',
      content: buildVideoContext({ title, videoUrl, transcriptText, transcriptStats })
    },
    ...historyToMessages(history),
    ...toolMessages,
    {
      role: 'user',
      content: buildUserTurnContent(userMessage, frameContext)
    }
  ];
}

function buildUserTurnContent(userMessage, frameContext) {
  const text = String(userMessage || '').trim();
  if (!frameContext?.imageUrl) {
    return text;
  }

  const timestamp = String(frameContext.timestamp || '').trim();
  const preface = timestamp
    ? `${text}\n\nAttached video frame timestamp: [${timestamp}]. Use the image as additional context when it is relevant.`
    : `${text}\n\nAn attached video frame is included as additional context. Use the image when it is relevant.`;

  return [
    {
      type: 'text',
      text: preface
    },
    {
      type: 'image_url',
      image_url: {
        url: frameContext.imageUrl
      }
    }
  ];
}

function buildVideoContext({ title, videoUrl, transcriptText, transcriptStats }) {
  return [
    `Video title: ${title}`,
    `Video URL: ${videoUrl}`,
    `Transcript status: ${transcriptStats.status}`,
    `Transcript segments: ${transcriptStats.segmentCount}`,
    '',
    'Transcript:',
    transcriptText || 'No transcript available.'
  ].join('\n');
}

function historyToMessages(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && typeof entry.text === 'string' && (entry.role === 'user' || entry.role === 'assistant'))
    .map((entry) => ({ role: entry.role, content: entry.text }));
}

async function completeChatCompletion({ provider, messages, signal, temperature }) {
  const normalizedMessages = normalizeMessagesForProvider(provider, messages);

  // Add ping interval to keep service worker alive during long generation
  const keepAliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(); } catch {}
  }, 20000);

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: provider.headers,
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages: normalizedMessages,
        stream: false,
        temperature
      })
    });

    if (!response.ok) {
      throw new Error(await buildHttpError(response));
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error('Model returned no text content.');
    }

    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map((item) => item?.text || '').join('');
    }

    if (typeof content !== 'string' || content.trim() === '') {
      if (message.reasoning_content) {
        content = message.reasoning_content;
      } else {
        throw new Error('Model returned no text content.');
      }
    }

    return content;
  } finally {
    clearInterval(keepAliveInterval);
  }
}

async function streamChatCompletion({ provider, messages, signal, temperature, onChunk }) {
  const normalizedMessages = normalizeMessagesForProvider(provider, messages);

  const keepAliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(); } catch {}
  }, 20000);

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: provider.headers,
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages: normalizedMessages,
        stream: true,
        temperature
      })
    });

    if (!response.ok) {
      throw new Error(await buildHttpError(response));
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response body was unavailable.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let hasStartedReasoning = false;
    let hasEndedReasoning = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') {
            continue;
          }

          const data = safeJsonParse(payload);
          const delta = data?.choices?.[0]?.delta;
          if (!delta) {
            continue;
          }

          const reasoningChunk = delta.reasoning_content;
          if (typeof reasoningChunk === 'string' && reasoningChunk.length > 0) {
            if (!hasStartedReasoning) {
              hasStartedReasoning = true;
              onChunk('<details class="thinking-pill"><summary><span class="thinking-pill__label">Thought Process</span><span class="thinking-pill__preview"></span></summary><div class="thinking-pill__body">');
            }
            onChunk(reasoningChunk);
          }

          const chunk = delta.content;
          if (typeof chunk === 'string' && chunk.length > 0) {
            if (hasStartedReasoning && !hasEndedReasoning) {
              hasEndedReasoning = true;
              onChunk('\n\n</details>\n\n');
            }
            onChunk(chunk);
          }
        }
      }
    }

    if (hasStartedReasoning && !hasEndedReasoning) {
      hasEndedReasoning = true;
      onChunk('\n\n</details>\n\n');
    }
  } finally {
    clearInterval(keepAliveInterval);
  }
}

async function webSearch(query, settings, sources, sourceByUrl, signal) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { text: 'Search failed: empty query.' };
  }

  if (settings.searchProvider === 'searxng') {
    return searchWithSearxng(query, settings.searxngBaseUrl, sources, sourceByUrl, signal);
  }

  return searchWithDuckDuckGo(query, sources, sourceByUrl, signal);
}

async function searchWithDuckDuckGo(query, sources, sourceByUrl, signal) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query.trim());

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with ${response.status}`);
  }

  const html = await response.text();
  const results = extractDuckDuckGoResults(html).slice(0, 5);
  if (results.length === 0) {
    return { text: `No search results found for ${query}.` };
  }

  const lines = [`Search query: ${query}`];

  for (const result of results) {
    const source = registerSource({
      url: result.url,
      title: result.title || result.url,
      sourceByUrl,
      sources
    });
    lines.push(`[${source.id}] ${source.title}`);
    lines.push(result.url);
    if (typeof result.snippet === 'string' && result.snippet.trim()) {
      lines.push(result.snippet.trim());
    }
    lines.push('Search engine: DuckDuckGo');
    lines.push('');
  }

  return { text: lines.join('\n') };
}

async function searchWithSearxng(query, searxngBaseUrl, sources, sourceByUrl, signal) {

  const url = new URL('/search', normalizeBaseUrl(searxngBaseUrl));
  url.searchParams.set('q', query.trim());
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en-US');

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`SearxNG search failed with ${response.status}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results.slice(0, 5) : [];
  if (results.length === 0) {
    return { text: `No search results found for ${query}.` };
  }

  const lines = [`Search query: ${query}`];

  for (const result of results) {
    const source = registerSource({
      url: result.url,
      title: result.title || result.url,
      sourceByUrl,
      sources
    });
    lines.push(`[${source.id}] ${source.title}`);
    lines.push(result.url);
    if (typeof result.content === 'string' && result.content.trim()) {
      lines.push(result.content.trim());
    }
    if (typeof result.engine === 'string' && result.engine.trim()) {
      lines.push(`Search engine: ${result.engine}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n') };
}

function extractDuckDuckGoResults(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return [];
  }

  const results = [];
  const regex = /<a[^>]*class="[^\"]*result__a[^\"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^\"]*result__snippet[^\"]*"[^>]*>|<div[^>]*class="[^\"]*result__snippet[^\"]*"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = resolveDuckDuckGoResultUrl(decodeEntities(match[1] || ''));
    const title = collapseWhitespace(decodeEntities(stripHtmlTags(match[2] || '')));
    const snippet = collapseWhitespace(decodeEntities(stripHtmlTags(match[3] || '')));

    if (!/^https?:\/\//i.test(href)) {
      continue;
    }

    results.push({ url: href, title, snippet });
  }

  return results;
}

function resolveDuckDuckGoResultUrl(url) {
  const decoded = decodeEntities(String(url || '').trim());
  if (!decoded) {
    return '';
  }

  const absolute = decoded.startsWith('//') ? `https:${decoded}` : decoded;

  try {
    const parsed = new URL(absolute, 'https://html.duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : parsed.toString();
  } catch {
    return absolute;
  }
}

async function readUrl(targetUrl, sources, sourceByUrl, signal) {
  if (typeof targetUrl !== 'string' || !/^https?:\/\//i.test(targetUrl)) {
    return { text: 'read_url failed: invalid URL.' };
  }

  const response = await fetch(targetUrl, { signal });
  if (!response.ok) {
    throw new Error(`read_url failed with ${response.status}`);
  }

  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = collapseWhitespace(decodeEntities(titleMatch?.[1] || targetUrl));
  const text = extractReadableText(html).slice(0, 6000);
  const source = registerSource({ url: targetUrl, title, sourceByUrl, sources });

  return {
    text: [`[${source.id}] ${source.title}`, targetUrl, text || 'No readable content extracted.'].join('\n\n')
  };
}

function registerSource({ url, title, sourceByUrl, sources }) {
  const normalizedUrl = normalizeSourceUrl(url);
  const existing = sourceByUrl.get(normalizedUrl);
  if (existing) {
    return existing;
  }

  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  const source = {
    id: sources.length + 1,
    url,
    title,
    hostname,
    faviconUrl: hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=32` : ''
  };

  sources.push(source);
  sourceByUrl.set(normalizedUrl, source);
  return source;
}

function getProviderConfig(settings) {
  if (settings.provider === 'transformers-js') {
    return {
      kind: 'transformers-js',
      model: settings.model || TRANSFORMERS_JS_MODELS[0].id,
      baseUrl: '',
      headers: {}
    };
  }

  if (settings.provider === 'lmstudio') {
    return {
      kind: 'lmstudio',
      baseUrl: normalizeOpenAiCompatibleBaseUrl(settings.lmStudioBaseUrl),
      model: settings.model,
      headers: {
        'Content-Type': 'application/json'
      }
    };
  }

  if (settings.provider === 'nvidia-nim') {
    if (!settings.nvidiaNimApiKey) {
      throw new Error('NVIDIA NIM API key is missing. Open the extension options page to configure it.');
    }

    return {
      kind: 'nvidia-nim',
      baseUrl: normalizeOpenAiCompatibleBaseUrl(settings.nvidiaNimBaseUrl),
      model: settings.model,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.nvidiaNimApiKey}`
      }
    };
  }

  if (!settings.openrouterApiKey) {
    throw new Error('OpenRouter API key is missing. Open the extension options page to configure it.');
  }

  return {
    kind: 'openrouter',
    baseUrl: normalizeOpenAiCompatibleBaseUrl(settings.openrouterBaseUrl),
    model: settings.model,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openrouterApiKey}`,
      'HTTP-Referer': chrome.runtime.getURL('options.html'),
      'X-Title': 'YouTube AI Sidebar'
    }
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      resolve({ ...DEFAULT_SETTINGS, ...stored });
    });
  });
}

function setSettings(nextSettings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(nextSettings, () => {
      resolve({ ...DEFAULT_SETTINGS, ...nextSettings });
    });
  });
}

async function handleGetModelCatalog(sendResponse) {
  try {
    const settings = await getSettings();
    const catalog = await getModelCatalog(settings);
    sendResponse({ ok: true, ...catalog });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'The model catalog could not be loaded.'
    });
  }
}

async function handleSetActiveModel(message, sendResponse) {
  const provider = String(message?.provider || '').trim();
  const model = String(message?.model || '').trim();

  if (!provider || !model) {
    sendResponse({ ok: false, error: 'A provider and model are required.' });
    return;
  }

  try {
    const settings = await getSettings();
    const nextSettings = await setSettings({
      ...settings,
      provider,
      model
    });
    sendResponse({ ok: true, settings: nextSettings });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'The active model could not be updated.'
    });
  }
}

async function getModelCatalog(settings) {
  const providers = buildProviderCatalogConfigs(settings);
  const groups = [];

  for (const provider of providers) {
    const result = await fetchProviderModels(provider);
    groups.push(result);
  }

  return {
    settings,
    groups
  };
}

function buildProviderCatalogConfigs(settings) {
  return [
    {
      key: 'openrouter',
      label: 'OpenRouter',
      enabled: Boolean(settings.openrouterApiKey),
      reason: settings.openrouterApiKey ? '' : 'OpenRouter API key is missing.',
      configFactory: () => getProviderConfig({ ...settings, provider: 'openrouter' })
    },
    {
      key: 'lmstudio',
      label: 'LM Studio',
      enabled: true,
      reason: '',
      configFactory: () => getProviderConfig({ ...settings, provider: 'lmstudio' })
    },
    {
      key: 'nvidia-nim',
      label: 'NVIDIA NIM',
      enabled: Boolean(settings.nvidiaNimApiKey),
      reason: settings.nvidiaNimApiKey ? '' : 'NVIDIA NIM API key is missing.',
      configFactory: () => getProviderConfig({ ...settings, provider: 'nvidia-nim' })
    },
    {
      key: 'transformers-js',
      label: 'Transformers.js (Experimental)',
      enabled: true,
      reason: '',
      static: true,
      configFactory: () => getProviderConfig({ ...settings, provider: 'transformers-js' })
    }
  ];
}

async function fetchProviderModels(providerDescriptor) {
  if (!providerDescriptor.enabled) {
    return {
      provider: providerDescriptor.key,
      label: providerDescriptor.label,
      available: false,
      error: providerDescriptor.reason,
      models: []
    };
  }

  // Static catalog for Transformers.js — no remote fetch needed
  if (providerDescriptor.static) {
    return {
      provider: providerDescriptor.key,
      label: providerDescriptor.label,
      available: true,
      error: '',
      models: [...TRANSFORMERS_JS_MODELS]
    };
  }

  try {
    const config = providerDescriptor.configFactory();
    const response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: config.headers
    });

    if (!response.ok) {
      throw new Error(await buildHttpError(response));
    }

    const payload = await response.json();
    return {
      provider: providerDescriptor.key,
      label: providerDescriptor.label,
      available: true,
      error: '',
      models: normalizeModelCatalog(payload)
    };
  } catch (error) {
    return {
      provider: providerDescriptor.key,
      label: providerDescriptor.label,
      available: false,
      error: error instanceof Error ? error.message : `The ${providerDescriptor.label} catalog could not be loaded.`,
      models: []
    };
  }
}

function normalizeModelCatalog(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  return entries
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      name: String(entry?.name || entry?.id || '').trim(),
      ownedBy: String(entry?.owned_by || entry?.publisher || '').trim(),
      contextLength: Number(entry?.context_length || entry?.max_context_length || entry?.top_provider?.context_length || 0) || 0
    }))
    .filter((entry) => entry.id)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildFallbackQuestions(title) {
  return [
    `What are the main takeaways from ${trimTitle(title)}?`,
    'Which moments in the video matter most?',
    'Can you summarize the strongest arguments made?'
  ];
}

function trimTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'this video';
  }

  return title.length > 40 ? `${title.slice(0, 37)}...` : title;
}

function extractJsonBlock(text) {
  if (typeof text !== 'string') {
    return '{}';
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1];
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : text;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function stripHtmlTags(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ');
}

function normalizeOpenAiCompatibleBaseUrl(url) {
  const trimmed = normalizeBaseUrl(url);

  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/v1';
    } else if (parsed.pathname === '/v1/') {
      parsed.pathname = '/v1';
    }

    return normalizeBaseUrl(parsed.toString());
  } catch {
    return trimmed;
  }
}

function normalizeMessagesForProvider(provider, messages) {
  const cleanedMessages = (Array.isArray(messages) ? messages : []).filter(
    (message) => message && hasUsableMessagePayload(message)
  );

  const systemBlocks = cleanedMessages
    .filter((message) => message.role === 'system')
    .map((message) => flattenMessageContentToText(message.content).trim())
    .filter(Boolean);

  const nonSystemMessages = cleanedMessages
    .filter((message) => message.role !== 'system')
    .map((message) => normalizeConversationMessage(message))
    .filter((message) => hasUsableMessagePayload(message));

  if (systemBlocks.length === 0) {
    return nonSystemMessages;
  }

  const systemPreamble = `System instructions:\n${systemBlocks.join('\n\n')}`;
  if (nonSystemMessages.length === 0) {
    return [{ role: 'user', content: systemPreamble }];
  }

  const [firstMessage, ...rest] = nonSystemMessages;
  if (firstMessage.role === 'user') {
    return [
      {
        role: 'user',
        content: prependSystemPreambleToContent(firstMessage.content, systemPreamble)
      },
      ...rest
    ];
  }

  return [
    { role: 'user', content: systemPreamble },
    ...nonSystemMessages
  ];
}

function hasUsableMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return normalizeMessageContent(content).length > 0;
}

function hasUsableMessagePayload(message) {
  if (!message) {
    return false;
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  if (message.role === 'tool') {
    return typeof message.tool_call_id === 'string' && hasUsableMessageContent(message.content);
  }

  return hasUsableMessageContent(message.content);
}

function normalizeConversationMessage(message) {
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : flattenMessageContentToText(message.content),
      tool_calls: message.tool_calls
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: flattenMessageContentToText(message.content)
    };
  }

  return {
    role: message.role,
    content: normalizeMessageContent(message.content)
  };
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        return {
          type: 'text',
          text: item.text.trim()
        };
      }

      if (item?.type === 'image_url' && typeof item.image_url?.url === 'string' && item.image_url.url.trim()) {
        return {
          type: 'image_url',
          image_url: {
            url: item.image_url.url.trim()
          }
        };
      }

      return null;
    })
    .filter(Boolean);
}

function flattenMessageContentToText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n\n');
}

function prependSystemPreambleToContent(content, systemPreamble) {
  if (typeof content === 'string') {
    return `${systemPreamble}\n\nUser request:\n${content}`;
  }

  const normalized = normalizeMessageContent(content);
  if (!normalized.length) {
    return systemPreamble;
  }

  return [
    {
      type: 'text',
      text: `${systemPreamble}\n\nUser request:`
    },
    ...normalized
  ];
}

function normalizeSourceUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function extractReadableText(html) {
  return collapseWhitespace(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function buildHttpError(response) {
  const body = await response.text().catch(() => '');
  return `Request failed with ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`;
}

function sendAssistantStatus(port, requestId, status) {
  if (!port || !requestId || !status) {
    return;
  }

  port.postMessage({
    type: 'assistant-status',
    requestId,
    status
  });
}

function formatStatusUrl(targetUrl) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./i, '');
  } catch {
    return targetUrl;
  }
}

async function streamChatWithTools({ provider, settings, port, requestId, messages, signal, temperature, onChunk }) {
  const workingMessages = [...messages];
  const sources = [];
  const sourceByUrl = new Map();

  const keepAliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(); } catch {}
  }, 20000);

  try {
    while (!signal.aborted) {
      const normalizedMessages = normalizeMessagesForProvider(provider, workingMessages);

      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: provider.headers,
        signal,
        body: JSON.stringify({
          model: provider.model,
          messages: normalizedMessages,
          stream: true,
          temperature,
          tools: getChatTools(),
          tool_choice: 'auto'
        })
      });

      if (!response.ok) {
        throw new Error(await buildHttpError(response));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Streaming response body was unavailable.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let contentSoFar = '';
      const toolCallAccumulator = {};
      let hasStartedReasoning = false;
      let hasEndedReasoning = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data:')) {
              continue;
            }

            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }

            const data = safeJsonParse(payload);
            const delta = data?.choices?.[0]?.delta;
            if (!delta) {
              continue;
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator[idx]) {
                  toolCallAccumulator[idx] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  };
                }
                if (tc.id) {
                  toolCallAccumulator[idx].id = tc.id;
                }
                if (tc.function?.name) {
                  toolCallAccumulator[idx].function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCallAccumulator[idx].function.arguments += tc.function.arguments;
                }
              }
            }

            const reasoningChunk = delta.reasoning_content;
            if (typeof reasoningChunk === 'string' && reasoningChunk.length > 0) {
              if (!hasStartedReasoning) {
                hasStartedReasoning = true;
                onChunk('<details class="thinking-pill"><summary><span class="thinking-pill__label">Thought Process</span><span class="thinking-pill__preview"></span></summary><div class="thinking-pill__body">');
              }
              onChunk(reasoningChunk);
            }

            const chunk = delta.content;
            if (typeof chunk === 'string' && chunk.length > 0) {
              if (hasStartedReasoning && !hasEndedReasoning) {
                hasEndedReasoning = true;
                onChunk('\n\n</details>\n\n');
              }
              contentSoFar += chunk;
              onChunk(chunk);
            }
          }
        }
      }

      if (hasStartedReasoning && !hasEndedReasoning) {
        hasEndedReasoning = true;
        onChunk('\n\n</details>\n\n');
      }

      const toolCalls = Object.values(toolCallAccumulator);
      if (!toolCalls.length) {
        return { sources };
      }

      // Tools were called — clear streamed content and execute
      port.postMessage({ type: 'assistant-clear', requestId });

      workingMessages.push({
        role: 'assistant',
        content: contentSoFar || '',
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        const toolResult = await executeToolCall({
          toolCall, settings, sources, sourceByUrl, signal, port, requestId
        });

        workingMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }

      // Send sources live so citations render during the next pass
      port.postMessage({ type: 'sources', requestId, sources });
    }

    throw new DOMException('The request was aborted.', 'AbortError');
  } finally {
    clearInterval(keepAliveInterval);
  }
}

async function executeToolCall({ toolCall, settings, sources, sourceByUrl, signal, port, requestId }) {
  const toolName = toolCall?.function?.name;
  const rawArguments = toolCall?.function?.arguments;
  const args = safeJsonParse(rawArguments || '{}') || {};

  if (toolName === 'web_search') {
    const query = collapseWhitespace(args.query || '').slice(0, 180);
    if (!query) {
      return 'web_search failed: missing query.';
    }

    sendAssistantStatus(port, requestId, 'Searching the web...');
    try {
      const result = await webSearch(query, settings, sources, sourceByUrl, signal);
      return result.text;
    } catch (error) {
      return `web_search failed for query: ${query}\n\n${error instanceof Error ? error.message : 'Unknown error.'}`;
    }
  }

  if (toolName === 'read_url') {
    const url = String(args.url || '').trim();
    if (!url) {
      return 'read_url failed: missing url.';
    }

    sendAssistantStatus(port, requestId, `Reading ${formatStatusUrl(url)}...`);
    try {
      const result = await readUrl(url, sources, sourceByUrl, signal);
      return result.text;
    } catch (error) {
      return `read_url failed for ${url}\n\n${error instanceof Error ? error.message : 'Unknown error.'}`;
    }
  }

  return `Unknown tool: ${toolName || 'unnamed tool'}`;
}

function getChatTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the public web for outside context, current facts, or historical information not present in the video transcript.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A short targeted search query.'
            }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_url',
        description: 'Fetch and read a specific HTTP or HTTPS URL when the user provides a link or when search results need to be opened.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The absolute URL to fetch.'
            }
          },
          required: ['url'],
          additionalProperties: false
        }
      }
    }
  ];
}

function supportsToolCalling(provider) {
  if (provider?.kind === 'transformers-js') {
    return false;
  }
  return provider?.kind === 'openrouter' || provider?.kind === 'nvidia-nim' || provider?.kind === 'lmstudio';
}

function flattenAssistantMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => item?.text || '')
    .join('');
}

// ── Transformers.js: offscreen document bridge ─────────────────────────────────

/**
 * Ensure the offscreen document is created.
 * The offscreen document hosts the actual Transformers.js pipeline.
 */
async function ensureOffscreenDocument() {
  if (_tjsOffscreenReady) {
    return;
  }

  // Check if an offscreen document already exists
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) {
    _tjsOffscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run Transformers.js ONNX model inference with WebGPU/WASM (requires DOM context).'
  });

  _tjsOffscreenReady = true;
}

/**
 * Generate a response using the offscreen document + Transformers.js.
 * Streams status updates via port messages, then emits the final text as chunks.
 */
async function transformersJsGenerate({ modelId, messages, signal, temperature, port, requestId, onChunk }) {
  const keepAliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(); } catch {}
  }, 20000);

  try {
    await ensureOffscreenDocument();

    if (signal.aborted) {
      throw new DOMException('The request was aborted.', 'AbortError');
    }

    // Flatten messages for the offscreen document
    const chatMessages = flattenMessagesForTransformersJs(messages);

    // Listen for status updates from the offscreen document
    const statusListener = (msg) => {
      if (msg?.type === 'tjs-status' && msg.requestId === requestId) {
        // Forward the status text to the sidebar
        const statusText = msg.text || '';
        if (statusText) {
          sendAssistantStatus(port, requestId, statusText);
        }
        // Forward download progress for richer UI
        if (msg.overallProgress !== undefined) {
          port.postMessage({
            type: 'assistant-download-progress',
            requestId,
            progress: msg.overallProgress,
            file: msg.file || '',
            filesTotal: msg.filesTotal || 0,
            filesCompleted: msg.filesCompleted || 0
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(statusListener);

    try {
      // Send generation request to offscreen document
      const response = await chrome.runtime.sendMessage({
        type: 'tjs-generate',
        requestId,
        modelId,
        messages: chatMessages,
        temperature
      });

      if (signal.aborted) {
        throw new DOMException('The request was aborted.', 'AbortError');
      }

      if (!response?.ok) {
        throw new Error(response?.error || 'Transformers.js inference failed.');
      }

      // Stream the text as chunks for visual effect
      const text = response.text || '';
      if (text) {
        const chunkSize = 8;
        for (let i = 0; i < text.length; i += chunkSize) {
          if (signal.aborted) {
            throw new DOMException('The request was aborted.', 'AbortError');
          }
          onChunk(text.slice(i, i + chunkSize));
        }
      }
    } finally {
      chrome.runtime.onMessage.removeListener(statusListener);
    }
  } finally {
    clearInterval(keepAliveInterval);
  }
}

/**
 * Convert the extension's internal message format into a simple
 * { role, content } array suitable for Transformers.js chat templates.
 * Importantly, ensures any system messages are hoisted to the very beginning.
 */
function flattenMessagesForTransformersJs(messages) {
  const systemMessages = [];
  const otherMessages = [];

  for (const msg of messages) {
    if (!msg || !msg.role) continue;

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Flatten multimodal content to text only (images not supported locally)
      text = msg.content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n\n');
    }

    if (!text.trim()) continue;

    // Aggressive clamp to prevent WebGPU memory bounds / Integer Overflow
    // on long YouTube transcripts for local 2B models (clamps to ~3,000 tokens).
    const MAX_LOCAL_CHARS = 12000;
    if (text.length > MAX_LOCAL_CHARS) {
      text = text.slice(0, MAX_LOCAL_CHARS) + '\n\n[... Transcript Truncated for Local Memory Limits ...]';
    }

    if (msg.role === 'system') {
      systemMessages.push(text.trim());
    } else {
      otherMessages.push({ role: msg.role, content: text.trim() });
    }
  }

  const result = [];
  if (systemMessages.length > 0) {
    result.push({ role: 'system', content: systemMessages.join('\n\n') });
  }
  
  result.push(...otherMessages);

  return result;
}