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
  temperature: 0.2
};

const portState = new WeakMap();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    const toolContext = await gatherWebContext({
      port,
      requestId: message.requestId,
      settings,
      title: message.title,
      videoUrl: message.videoUrl,
      transcriptStatus: message.transcriptStats?.status,
      userMessage: message.userMessage,
      signal: state.controller.signal
    });

    port.postMessage({
      type: 'sources',
      requestId: message.requestId,
      sources: toolContext.sources
    });

    const finalMessages = buildAnswerMessages({
      title: message.title,
      videoUrl: message.videoUrl,
      transcriptText: message.transcriptText,
      transcriptStats: message.transcriptStats,
      history: message.history,
      userMessage: message.userMessage,
      toolMessages: toolContext.toolMessages
    });

    sendAssistantStatus(port, message.requestId, 'Generating answer...');

    await streamChatCompletion({
      provider,
      messages: finalMessages,
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

    port.postMessage({
      type: 'assistant-done',
      requestId: message.requestId,
      sources: toolContext.sources
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

    const raw = await completeChatCompletion({
      provider,
      messages: prompt,
      signal: state.controller.signal,
      temperature: 0.3
    });

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

function buildAnswerMessages({ title, videoUrl, transcriptText, transcriptStats, history, userMessage, toolMessages }) {
  return [
    {
      role: 'system',
      content: [
        'You are an AI assistant embedded beside a YouTube video.',
        'Answer with concise Markdown.',
        'Ground claims in the provided transcript whenever possible.',
        'When using transcript evidence, cite timestamps inline like [03:12] or [1:02:09].',
        'When using web/tool evidence, cite only with the provided numeric source markers like [1] and [2].',
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
      content: userMessage
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
              onChunk('<details><summary>Thought Process</summary>\n\n');
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
    const href = decodeEntities(match[1] || '');
    const title = collapseWhitespace(decodeEntities(stripHtmlTags(match[2] || '')));
    const snippet = collapseWhitespace(decodeEntities(stripHtmlTags(match[3] || '')));

    if (!/^https?:\/\//i.test(href)) {
      continue;
    }

    results.push({ url: href, title, snippet });
  }

  return results;
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
    (message) => message && typeof message.content === 'string' && message.content.trim().length > 0
  );

  if (provider?.kind !== 'lmstudio') {
    return cleanedMessages;
  }

  const systemBlocks = cleanedMessages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean);

  const nonSystemMessages = cleanedMessages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => message.content.length > 0);

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
        content: `${systemPreamble}\n\nUser request:\n${firstMessage.content}`
      },
      ...rest
    ];
  }

  return [
    { role: 'user', content: systemPreamble },
    ...nonSystemMessages
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

async function gatherWebContext({ port, requestId, settings, title, videoUrl, transcriptStatus, userMessage, signal }) {
  const sources = [];
  const sourceByUrl = new Map();
  const toolMessages = [];
  const urls = extractUrls(userMessage).slice(0, 2);

  for (const targetUrl of urls) {
    try {
      sendAssistantStatus(port, requestId, `Reading ${formatStatusUrl(targetUrl)}...`);
      const result = await readUrl(targetUrl, sources, sourceByUrl, signal);
      toolMessages.push({
        role: 'system',
        content: [
          'External URL context:',
          result.text,
          'Use the provided numeric source markers when citing these claims.'
        ].join('\n\n')
      });
    } catch (error) {
      toolMessages.push({
        role: 'system',
        content: [
          `External URL fetch failed for ${targetUrl}.`,
          error instanceof Error ? error.message : 'Unknown error.'
        ].join('\n\n')
      });
    }
  }

  if (shouldUseWebSearch({ userMessage, transcriptStatus }) && !signal.aborted) {
    const searchQuery = buildWebSearchQuery({ title, userMessage, videoUrl });
    try {
      sendAssistantStatus(port, requestId, 'Searching the web...');
      const result = await webSearch(searchQuery, settings.searxngBaseUrl, sources, sourceByUrl, signal);
      toolMessages.push({
        role: 'system',
        content: [
          'Web search context:',
          result.text,
          'Use the provided numeric source markers when citing these claims.'
        ].join('\n\n')
      });
    } catch (error) {
      toolMessages.push({
        role: 'system',
        content: [
          `Web search failed for query: ${searchQuery}`,
          error instanceof Error ? error.message : 'Unknown error.'
        ].join('\n\n')
      });
    }
  }

  return { sources, toolMessages };
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

function extractUrls(text) {
  if (typeof text !== 'string') {
    return [];
  }

  return Array.from(text.matchAll(/https?:\/\/[^\s)\]>"']+/gi), (match) => match[0]);
}

function shouldUseWebSearch({ userMessage, transcriptStatus }) {
  const normalized = String(userMessage || '').toLowerCase();
  if (!normalized.trim()) {
    return false;
  }

  const explicitSearchHints = [
    'search',
    'look up',
    'web',
    'online',
    'internet',
    'google',
    'news',
    'latest',
    'current',
    'today',
    'recent',
    'source',
    'sources',
    'citation',
    'citations',
    'reference',
    'references'
  ];

  if (explicitSearchHints.some((hint) => normalized.includes(hint))) {
    return true;
  }

  return String(transcriptStatus || '').toLowerCase() !== 'transcript ready';
}

function buildWebSearchQuery({ title, userMessage, videoUrl }) {
  const trimmedTitle = trimTitle(title);
  const query = collapseWhitespace(userMessage).slice(0, 180);
  return `${query} ${trimmedTitle} ${videoUrl}`.trim();
}

function formatStatusUrl(targetUrl) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./i, '');
  } catch {
    return targetUrl;
  }
}