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

const app = document.getElementById('app');

void render();

async function render() {
  const settings = await getSettings();

  app.innerHTML = `
    <style>
      :root {
        color-scheme: dark;
        --bg: #0c0d10;
        --panel: rgba(22, 24, 29, 0.92);
        --panel-strong: #15171c;
        --line: rgba(255, 255, 255, 0.08);
        --text: #f3efe5;
        --muted: rgba(243, 239, 229, 0.62);
        --amber: #f0c25b;
        --cyan: #52bfff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(240, 194, 91, 0.16), transparent 24%),
          radial-gradient(circle at bottom right, rgba(82, 191, 255, 0.14), transparent 28%),
          linear-gradient(180deg, #0c0d10, #111318);
        color: var(--text);
        font-family: Georgia, 'Times New Roman', serif;
      }

      .page {
        max-width: 980px;
        margin: 0 auto;
        padding: 48px 24px 72px;
      }

      .hero {
        margin-bottom: 28px;
      }

      .hero__eyebrow {
        font: 600 12px/1.2 'Trebuchet MS', Verdana, sans-serif;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: rgba(240, 194, 91, 0.85);
      }

      h1 {
        margin: 12px 0 10px;
        font-size: clamp(42px, 7vw, 72px);
        line-height: 0.95;
      }

      .hero p {
        max-width: 700px;
        margin: 0;
        color: var(--muted);
        font-size: 17px;
      }

      form {
        display: grid;
        gap: 18px;
      }

      .panel {
        padding: 22px;
        border-radius: 26px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        color: var(--muted);
      }

      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        padding: 12px 14px;
        font: inherit;
      }

      .actions {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        background: linear-gradient(135deg, var(--amber), var(--cyan));
        color: #111;
        font-weight: 700;
        cursor: pointer;
      }

      .status {
        color: var(--muted);
        font-size: 13px;
      }

      .note {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
    </style>
    <div class="page">
      <section class="hero">
        <div class="hero__eyebrow">YouTube AI Sidebar</div>
        <h1>Model, Tools, and Streaming Settings</h1>
        <p>Choose the provider endpoint, the model, and the two external tools the sidebar can use while answering questions about the current video.</p>
      </section>
      <form>
        <section class="panel grid">
          <label>
            Provider
            <select name="provider">
              <option value="openrouter" ${settings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
              <option value="lmstudio" ${settings.provider === 'lmstudio' ? 'selected' : ''}>LM Studio</option>
              <option value="nvidia-nim" ${settings.provider === 'nvidia-nim' ? 'selected' : ''}>NVIDIA NIM</option>
            </select>
          </label>
          <label>
            Search provider
            <select name="searchProvider">
              <option value="duckduckgo" ${settings.searchProvider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo</option>
              <option value="searxng" ${settings.searchProvider === 'searxng' ? 'selected' : ''}>SearxNG</option>
            </select>
          </label>
          <label>
            Model
            <input name="model" value="${escapeHtml(settings.model)}" />
          </label>
          <label>
            Temperature
            <input name="temperature" type="number" min="0" max="2" step="0.1" value="${settings.temperature}" />
          </label>
        </section>
        <section class="panel grid">
          <label>
            OpenRouter base URL
            <input name="openrouterBaseUrl" value="${escapeHtml(settings.openrouterBaseUrl)}" />
          </label>
          <label>
            OpenRouter API key
            <input name="openrouterApiKey" type="password" value="${escapeHtml(settings.openrouterApiKey)}" />
          </label>
          <label>
            LM Studio base URL
            <input name="lmStudioBaseUrl" value="${escapeHtml(settings.lmStudioBaseUrl)}" />
          </label>
          <label>
            NVIDIA NIM base URL
            <input name="nvidiaNimBaseUrl" value="${escapeHtml(settings.nvidiaNimBaseUrl)}" />
          </label>
          <label>
            NVIDIA NIM API key
            <input name="nvidiaNimApiKey" type="password" value="${escapeHtml(settings.nvidiaNimApiKey)}" />
          </label>
          <label>
            SearxNG base URL
            <input name="searxngBaseUrl" value="${escapeHtml(settings.searxngBaseUrl)}" />
          </label>
        </section>
        <section class="panel">
          <p class="note">The extension streams final answers from the selected model provider. Before the streamed response starts, it can also read pasted URLs and run web lookups through the selected search provider.</p>
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
      temperature: Number(formData.get('temperature') || DEFAULT_SETTINGS.temperature)
    };

    await setSettings(nextSettings);
    status.textContent = 'Saved. Reload the extension or refresh YouTube tabs if needed.';
  });
}

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