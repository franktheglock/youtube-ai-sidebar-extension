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
  temperature: 0.2,
  disableAutoQuestions: false
};

const app = document.getElementById('app');

void render();

async function render() {
  const settings = await getSettings();

  app.innerHTML = `
    <style>
      :root {
        color-scheme: dark;
        --bg: #090a0d;
        --panel-bg: rgba(18, 18, 18, 0.78);
        --panel-elevated: rgba(28, 28, 28, 0.48);
        --panel-soft: rgba(255, 255, 255, 0.04);
        --panel-hover: rgba(255, 255, 255, 0.08);
        --line: rgba(255, 255, 255, 0.1);
        --line-soft: rgba(255, 255, 255, 0.05);
        --text: #fdfdfd;
        --text-muted: #bababa;
        --text-faint: #818181;
        --accent: #a3c2ff;
        --accent-strong: #d9e5ff;
        --success: #8fd0a1;
        --user-bg: linear-gradient(135deg, #1d3557, #16263a);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(163, 194, 255, 0.16), transparent 24%),
          radial-gradient(circle at bottom right, rgba(255, 255, 255, 0.08), transparent 28%),
          linear-gradient(180deg, #090a0d, #101216 52%, #0b0c10);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      .page {
        max-width: 1080px;
        margin: 0 auto;
        padding: 36px 24px 56px;
      }

      .hero {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.75fr);
        gap: 18px;
        margin-bottom: 18px;
      }

      .hero__eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .hero__eyebrow::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 10px var(--accent);
      }

      h1 {
        margin: 8px 0 10px;
        font-size: clamp(30px, 5vw, 52px);
        line-height: 0.98;
        letter-spacing: -0.04em;
      }

      .hero p {
        margin: 0;
        max-width: 720px;
        color: var(--text-muted);
        font-size: 15px;
        line-height: 1.65;
      }

      .surface {
        border: 1px solid var(--line);
        border-radius: 20px;
        background: var(--panel-bg);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }

      .hero__main,
      .hero__meta,
      .panel {
        position: relative;
        overflow: hidden;
      }

      .hero__main,
      .hero__meta {
        padding: 20px;
      }

      .hero__main::after,
      .hero__meta::after,
      .panel::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 35%);
      }

      .hero__meta {
        display: grid;
        gap: 14px;
        align-content: start;
      }

      .hero__meta-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }

      .meta-list {
        display: grid;
        gap: 10px;
      }

      .meta-item {
        display: grid;
        gap: 4px;
        padding: 12px 14px;
        border: 1px solid var(--line-soft);
        border-radius: 14px;
        background: var(--panel-elevated);
      }

      .meta-item__label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-faint);
      }

      .meta-item__value {
        color: var(--text);
        font-size: 13px;
        line-height: 1.4;
      }

      form {
        display: grid;
        gap: 16px;
      }

      .panel {
        padding: 18px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }

      .panel__header {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--line-soft);
      }

      .panel__eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
        color: var(--text-faint);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .panel__eyebrow::before {
        content: '';
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--accent);
      }

      .panel__title {
        margin: 0;
        color: var(--text);
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }

      .panel__summary {
        margin: 4px 0 0;
        color: var(--text-muted);
        font-size: 13px;
        line-height: 1.55;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel-soft);
        color: var(--text-muted);
        font-size: 12px;
        white-space: nowrap;
      }

      .pill::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--success);
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        color: var(--text-muted);
        position: relative;
        z-index: 1;
      }

      .field-label {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }

      .field-label__name {
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
      }

      .field-label__hint {
        color: var(--text-faint);
        font-size: 11px;
      }

      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel-elevated);
        color: var(--text);
        padding: 12px 14px;
        font: inherit;
        transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
      }

      input:hover,
      select:hover,
      textarea:hover {
        background: var(--panel-hover);
      }

      input:focus,
      select:focus,
      textarea:focus {
        outline: none;
        border-color: rgba(163, 194, 255, 0.35);
        box-shadow: 0 0 0 3px rgba(163, 194, 255, 0.14);
        background: rgba(255, 255, 255, 0.08);
      }

      .actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 14px;
        position: relative;
        z-index: 1;
      }

      button {
        border: 1px solid rgba(163, 194, 255, 0.18);
        border-radius: 999px;
        padding: 12px 18px;
        background: var(--user-bg);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
        transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
      }

      button:hover {
        transform: translateY(-1px);
        border-color: rgba(163, 194, 255, 0.3);
        box-shadow: 0 14px 30px rgba(0, 0, 0, 0.3);
      }

      .status {
        color: var(--text-muted);
        font-size: 13px;
      }

      .note {
        position: relative;
        z-index: 1;
        margin: 0 0 14px;
        color: var(--text-muted);
        font-size: 13px;
        line-height: 1.6;
      }

      @media (max-width: 860px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        .page {
          padding: 20px 14px 28px;
        }

        .panel,
        .hero__main,
        .hero__meta {
          padding: 16px;
        }

        .actions {
          align-items: flex-start;
        }

        button {
          width: 100%;
          justify-content: center;
        }
      }
    </style>
    <div class="page">
      <section class="hero">
        <div class="hero__main surface">
          <div class="hero__eyebrow">YouTube AI Sidebar</div>
          <h1>Model, tool, and streaming settings</h1>
          <p>Keep the options page in the same visual language as the in-video sidebar: dark glass panels, compact controls, and quick context about what each setting affects.</p>
        </div>
        <aside class="hero__meta surface">
          <p class="hero__meta-title">What this controls</p>
          <div class="meta-list">
            <div class="meta-item">
              <span class="meta-item__label">Answer model</span>
              <span class="meta-item__value">Select which provider and model stream final responses in the sidebar.</span>
            </div>
            <div class="meta-item">
              <span class="meta-item__label">Web context</span>
              <span class="meta-item__value">Pick the search engine used when a question needs outside context beyond the transcript.</span>
            </div>
            <div class="meta-item">
              <span class="meta-item__label">Endpoints</span>
              <span class="meta-item__value">Point the extension at your preferred hosted APIs or local inference server.</span>
            </div>
          </div>
        </aside>
      </section>
      <form>
        <section class="panel surface">
          <div class="panel__header">
            <div>
              <div class="panel__eyebrow">Runtime</div>
              <h2 class="panel__title">Core behavior</h2>
              <p class="panel__summary">These are the settings that change the sidebar's day-to-day behavior while you chat with a video.</p>
            </div>
            <div class="pill">Synced with chrome.storage</div>
          </div>
          <div class="grid">
          <label>
            <span class="field-label"><span class="field-label__name">Provider</span><span class="field-label__hint">Stream target</span></span>
            <select name="provider">
              <option value="openrouter" ${settings.provider === "openrouter" ? "selected" : ""}>OpenRouter</option>
              <option value="lmstudio" ${settings.provider === "lmstudio" ? "selected" : ""}>LM Studio</option>
              <option value="nvidia-nim" ${settings.provider === "nvidia-nim" ? "selected" : ""}>NVIDIA NIM</option>
              <option value="transformers-js" ${settings.provider === "transformers-js" ? "selected" : ""}>Transformers.js (Experimental)</option>
            </select>
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">Search provider</span><span class="field-label__hint">Outside context</span></span>
            <select name="searchProvider">
              <option value="duckduckgo" ${settings.searchProvider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo</option>
              <option value="searxng" ${settings.searchProvider === 'searxng' ? 'selected' : ''}>SearxNG</option>
            </select>
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">Model</span><span class="field-label__hint">Provider-specific</span></span>
            <div data-role="model-container">
              <input name="model" value="${escapeHtml(settings.model)}" data-role="model-input" style="${settings.provider === 'transformers-js' ? 'display:none' : ''}" />
              <select name="model-select" data-role="model-select" style="${settings.provider === 'transformers-js' ? '' : 'display:none'}">
                <option value="onnx-community/Qwen3.5-2B-ONNX" ${settings.model === 'onnx-community/Qwen3.5-2B-ONNX' ? 'selected' : ''}>Qwen 3.5 2B</option>
                <option value="onnx-community/gemma-4-E2B-it-ONNX" ${settings.model === 'onnx-community/gemma-4-E2B-it-ONNX' ? 'selected' : ''}>Gemma 4 E2B</option>
                <option value="LiquidAI/LFM2.5-1.2B-Instruct-ONNX" ${settings.model === 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX' ? 'selected' : ''}>LFM 2.5 1.2B</option>
              </select>
            </div>
          </label>
          <div data-role="tjs-notice" style="${settings.provider === 'transformers-js' ? '' : 'display:none'}; grid-column: 1 / -1;">
            <div style="padding: 12px 14px; border: 1px solid rgba(255, 50, 50, 0.25); border-radius: 14px; background: rgba(255, 50, 50, 0.06); font-size: 12px; line-height: 1.55; color: var(--text-muted); margin-bottom: 12px;">
              <strong style="color: #ff6b6b;">🚨 BROKEN / HIGHLY EXPERIMENTAL ATM</strong><br>
              Transformers.js runs the language model locally in your browser leveraging WebGPU. <strong style="color:var(--text);">Current ONNX models are highly unstable on long YouTube transcripts and frequently crash WebGPU buffers.</strong> Use with caution. Expect crashes until upstream fixes are released.<br>
              <span style="color: var(--text-faint);">• First load downloads 600MB–1.5GB (cached after)&nbsp; • Requires WebGPU-capable browser&nbsp; • Web search and URL tools are disabled</span>
            </div>
            <div style="padding: 14px; border: 1px solid var(--line-soft); border-radius: 14px; background: var(--panel-elevated);">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                <span style="font-size: 12px; font-weight: 600; color: var(--text); letter-spacing: 0.04em;">Downloaded Models</span>
                <span data-role="tjs-cache-total" style="font-size: 11px; color: var(--text-faint);"></span>
              </div>
              <div data-role="tjs-model-list" style="display: grid; gap: 8px;">
                <div data-tjs-model="onnx-community/Qwen3.5-2B-ONNX" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 10px; background: var(--panel-soft); font-size: 12px;">
                  <span style="color: var(--text);">Qwen 3.5 2B</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span data-role="tjs-badge" style="color: var(--text-faint); font-size: 11px;">Checking...</span>
                    <button type="button" data-role="tjs-download" data-model="onnx-community/Qwen3.5-2B-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(143, 208, 161, 0.15); color: #8fd0a1; border: 1px solid rgba(143, 208, 161, 0.2); cursor: pointer;">Download</button>
                    <button type="button" data-role="tjs-delete" data-model="onnx-community/Qwen3.5-2B-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(255, 50, 50, 0.15); color: #ff6b6b; border: 1px solid rgba(255, 50, 50, 0.2); cursor: pointer;">Delete</button>
                  </div>
                </div>
                <div data-tjs-model="onnx-community/gemma-4-E2B-it-ONNX" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 10px; background: var(--panel-soft); font-size: 12px;">
                  <span style="color: var(--text);">Gemma 4 E2B</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span data-role="tjs-badge" style="color: var(--text-faint); font-size: 11px;">Checking...</span>
                    <button type="button" data-role="tjs-download" data-model="onnx-community/gemma-4-E2B-it-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(143, 208, 161, 0.15); color: #8fd0a1; border: 1px solid rgba(143, 208, 161, 0.2); cursor: pointer;">Download</button>
                    <button type="button" data-role="tjs-delete" data-model="onnx-community/gemma-4-E2B-it-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(255, 50, 50, 0.15); color: #ff6b6b; border: 1px solid rgba(255, 50, 50, 0.2); cursor: pointer;">Delete</button>
                  </div>
                </div>
                <div data-tjs-model="LiquidAI/LFM2.5-1.2B-Instruct-ONNX" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 10px; background: var(--panel-soft); font-size: 12px;">
                  <span style="color: var(--text);">LFM 2.5 1.2B</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span data-role="tjs-badge" style="color: var(--text-faint); font-size: 11px;">Checking...</span>
                    <button type="button" data-role="tjs-download" data-model="LiquidAI/LFM2.5-1.2B-Instruct-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(143, 208, 161, 0.15); color: #8fd0a1; border: 1px solid rgba(143, 208, 161, 0.2); cursor: pointer;">Download</button>
                    <button type="button" data-role="tjs-delete" data-model="LiquidAI/LFM2.5-1.2B-Instruct-ONNX" style="display: none; padding: 4px 8px; font-size: 10px; border-radius: 6px; background: rgba(255, 50, 50, 0.15); color: #ff6b6b; border: 1px solid rgba(255, 50, 50, 0.2); cursor: pointer;">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <label>
            <span class="field-label"><span class="field-label__name">Temperature</span><span class="field-label__hint">0.0 - 2.0</span></span>
            <input name="temperature" type="number" min="0" max="2" step="0.1" value="${settings.temperature}" />
          </label>
          </div>
        </section>
        <section class="panel surface">
          <div class="panel__header">
            <div>
              <div class="panel__eyebrow">Connections</div>
              <h2 class="panel__title">Endpoints and keys</h2>
              <p class="panel__summary">Match these to the services you actually use. Unused fields can stay empty.</p>
            </div>
          </div>
          <div class="grid">
          <label>
            <span class="field-label"><span class="field-label__name">OpenRouter base URL</span></span>
            <input name="openrouterBaseUrl" value="${escapeHtml(settings.openrouterBaseUrl)}" />
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">OpenRouter API key</span></span>
            <input name="openrouterApiKey" type="password" value="${escapeHtml(settings.openrouterApiKey)}" />
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">LM Studio base URL</span></span>
            <input name="lmStudioBaseUrl" value="${escapeHtml(settings.lmStudioBaseUrl)}" />
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">NVIDIA NIM base URL</span></span>
            <input name="nvidiaNimBaseUrl" value="${escapeHtml(settings.nvidiaNimBaseUrl)}" />
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">NVIDIA NIM API key</span></span>
            <input name="nvidiaNimApiKey" type="password" value="${escapeHtml(settings.nvidiaNimApiKey)}" />
          </label>
          <label>
            <span class="field-label"><span class="field-label__name">SearxNG base URL</span><span class="field-label__hint">Optional override</span></span>
            <input name="searxngBaseUrl" value="${escapeHtml(settings.searxngBaseUrl)}" />
          </label>
          </div>
        </section>
        <section class="panel surface">
          <div class="panel__header">
            <div>
              <div class="panel__eyebrow">Save</div>
              <h2 class="panel__title">Apply changes</h2>
            </div>
          </div>
          <p class="note">The extension streams final answers from the selected model provider. Before the streamed response starts, it can also read pasted URLs and run web lookups through the selected search provider.</p>
          <div class="setting-group advanced-block">
          <label>General Preferences</label>
          <div class="checkbox-setting">
            <input type="checkbox" id="disableAutoQuestions" name="disableAutoQuestions" ${settings.disableAutoQuestions ? 'checked' : ''}>
            <label for="disableAutoQuestions" style="display:inline;font-size:13px;">Disable Automatic Starter Questions</label>
            <p style="margin-top:4px;font-size:12px;color:var(--text-faint);">If checked, the extension will no longer automatically ask the LLM to generate initial questions when a transcript loads. Saves API credits/local processing power.</p>
          </div>
        </div>

        <div class="actions">
            <button type="submit">Save settings</button>
            <span class="status" data-role="status">Settings are stored in chrome.storage.sync.</span>
          </div>
        </section>
      </form>
    </div>
  `;

  const form = app.querySelector('form');
  const status = app.querySelector('[data-role="status"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const nextSettings = {
      provider: String(formData.get('provider') || DEFAULT_SETTINGS.provider),
      model: String(formData.get('model') || DEFAULT_SETTINGS.model),
      openrouterApiKey: String(formData.get('openrouterApiKey') || ''),
      lmStudioBaseUrl: String(formData.get('lmStudioBaseUrl') || DEFAULT_SETTINGS.lmStudioBaseUrl),
      nvidiaNimBaseUrl: String(formData.get('nvidiaNimBaseUrl') || DEFAULT_SETTINGS.nvidiaNimBaseUrl),
      nvidiaNimApiKey: String(formData.get('nvidiaNimApiKey') || ''),
      openrouterBaseUrl: String(formData.get('openrouterBaseUrl') || DEFAULT_SETTINGS.openrouterBaseUrl),
      searchProvider: String(formData.get('searchProvider') || DEFAULT_SETTINGS.searchProvider),
      searxngBaseUrl: String(formData.get('searxngBaseUrl') || DEFAULT_SETTINGS.searxngBaseUrl),
      temperature: Number(formData.get('temperature') || DEFAULT_SETTINGS.temperature),
      disableAutoQuestions: formData.get('disableAutoQuestions') === 'on'
    };

    await setSettings(nextSettings);
    status.textContent = "Saved. Reload the extension or refresh YouTube tabs if needed.";
  });

  // Dynamic provider switching for Transformers.js
  const providerSelect = form.querySelector('[name="provider"]');
  const modelInput = form.querySelector('[data-role="model-input"]');
  const modelSelect = form.querySelector('[data-role="model-select"]');
  const tjsNotice = form.querySelector('[data-role="tjs-notice"]');

  providerSelect.addEventListener('change', () => {
    const isTjs = providerSelect.value === 'transformers-js';
    modelInput.style.display = isTjs ? 'none' : '';
    modelSelect.style.display = isTjs ? '' : 'none';
    tjsNotice.style.display = isTjs ? '' : 'none';

    if (isTjs) {
      modelInput.value = modelSelect.value;
      checkTjsModelCache();
    }
  });

  modelSelect.addEventListener('change', () => {
    modelInput.value = modelSelect.value;
  });

  // Check cache on initial load if provider is transformers-js
  if (settings.provider === 'transformers-js') {
    checkTjsModelCache();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function checkTjsModelCache() {
  const modelIds = [
    'onnx-community/Qwen3.5-2B-ONNX',
    'onnx-community/gemma-4-E2B-it-ONNX',
    'LiquidAI/LFM2.5-1.2B-Instruct-ONNX'
  ];

  chrome.runtime.sendMessage(
    { type: 'tjs-check-cache', modelIds },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        // Fallback: just check chrome.storage.local for cached flags
        chrome.storage.local.get({ tjsCachedModels: {} }, (data) => {
          const cached = data.tjsCachedModels || {};
          for (const modelId of modelIds) {
            const row = document.querySelector(`[data-tjs-model="${modelId}"]`);
            if (!row) continue;
            const badge = row.querySelector('[data-role="tjs-badge"]');
            const deleteBtn = row.querySelector('[data-role="tjs-delete"]');
            const downloadBtn = row.querySelector('[data-role="tjs-download"]');
            if (!badge) continue;

            if (cached[modelId]) {
              badge.textContent = '✓ Cached';
              badge.style.color = '#8fd0a1';
              if (deleteBtn) deleteBtn.style.display = 'block';
              if (downloadBtn) downloadBtn.style.display = 'none';
            } else {
              badge.textContent = 'Not downloaded';
              badge.style.color = 'var(--text-faint)';
              if (deleteBtn) deleteBtn.style.display = 'none';
              if (downloadBtn) downloadBtn.style.display = 'block';
            }
          }
        });
        return;
      }

      const { cached, totalCacheSize } = response;

      // Update total cache size
      const totalEl = document.querySelector('[data-role="tjs-cache-total"]');
      if (totalEl) {
        totalEl.textContent = totalCacheSize > 0 ? `Total: ${formatBytes(totalCacheSize)}` : '';
      }

      for (const modelId of modelIds) {
        const row = document.querySelector(`[data-tjs-model="${modelId}"]`);
        if (!row) continue;
        const badge = row.querySelector('[data-role="tjs-badge"]');
        const deleteBtn = row.querySelector('[data-role="tjs-delete"]');
        const downloadBtn = row.querySelector('[data-role="tjs-download"]');
        if (!badge) continue;

        const info = cached?.[modelId];
        if (info?.downloaded) {
          const size = info.sizeBytes > 0 ? formatBytes(info.sizeBytes) : '';
          const files = info.fileCount > 0 ? `${info.fileCount} files` : '';
          const detail = [size, files].filter(Boolean).join(' · ');
          badge.textContent = `✓ ${detail || 'Cached'}`;
          badge.style.color = '#8fd0a1';
          if (deleteBtn) deleteBtn.style.display = 'block';
          if (downloadBtn) downloadBtn.style.display = 'none';
        } else {
          badge.textContent = 'Not downloaded';
          badge.style.color = 'var(--text-faint)';
          if (deleteBtn) deleteBtn.style.display = 'none';
          if (downloadBtn) downloadBtn.style.display = 'block';
        }
      }
    }
  );
}

// Listen for download progress updates during standalone downloads
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'tjs-download-progress') {
    const { modelId, text, overallProgress } = message;
    const row = document.querySelector(`[data-tjs-model="${modelId}"]`);
    if (!row) return;

    const badge = row.querySelector('[data-role="tjs-badge"]');
    if (badge) {
      badge.textContent = text || `Downloading... ${overallProgress}%`;
      badge.style.color = '#a3c2ff';
    }

    const downloadBtn = row.querySelector('[data-role="tjs-download"]');
    if (downloadBtn) {
      downloadBtn.style.display = 'none'; // Hide while downloading
    }
  }
});

// Global delegated listener for delete and download buttons
document.addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('[data-role="tjs-delete"]');
  if (deleteBtn) {
    const modelId = deleteBtn.getAttribute('data-model');
    if (!modelId) return;

    const confirmDelete = confirm(`Are you sure you want to delete ${modelId} from your local cache? You will need to re-download it to use it again.`);
    if (!confirmDelete) return;

    deleteBtn.textContent = 'Deleting...';
    deleteBtn.disabled = true;
    deleteBtn.style.opacity = '0.5';

    chrome.runtime.sendMessage({ type: 'tjs-delete-model', modelId }, (response) => {
      deleteBtn.disabled = false;
      deleteBtn.style.opacity = '1';
      deleteBtn.textContent = 'Delete';
      if (chrome.runtime.lastError || !response?.ok) {
        alert(`Failed to delete model: ${chrome.runtime.lastError?.message || response?.error || 'Unknown error'}`);
      }
      checkTjsModelCache();
    });
    return;
  }

  const downloadBtn = e.target.closest('[data-role="tjs-download"]');
  if (downloadBtn) {
    const modelId = downloadBtn.getAttribute('data-model');
    if (!modelId) return;

    downloadBtn.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'tjs-download-model', modelId }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        alert(`Failed to download model: ${chrome.runtime.lastError?.message || response?.error || 'Unknown error'}`);
      }
      checkTjsModelCache();
    });
  }
});

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      resolve({ ...DEFAULT_SETTINGS, ...settings });
    });
  });
}

function setSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, () => resolve());
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}