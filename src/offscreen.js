// offscreen.js — Runs Transformers.js inference in a full DOM context
// (service workers lack XMLHttpRequest / DOM needed by ONNX Runtime)

import { pipeline, env } from '@huggingface/transformers';

// Use locally bundled ONNX Runtime files (extension CSP blocks the jsdelivr CDN)
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');

let _cache = { modelId: null, pipe: null, loading: false };

/**
 * Get or create a cached text-generation pipeline.
 */
async function getPipeline(modelId, onProgress) {
  if (_cache.pipe && _cache.modelId === modelId) {
    return _cache.pipe;
  }

  if (_cache.pipe && _cache.modelId !== modelId) {
    try { await _cache.pipe?.dispose?.(); } catch {}
    _cache = { modelId: null, pipe: null, loading: false };
  }

  if (_cache.loading) {
    while (_cache.loading) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (_cache.pipe && _cache.modelId === modelId) {
      return _cache.pipe;
    }
  }

  _cache.loading = true;

  try {
    // Detect WebGPU
    let device = 'wasm';
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) device = 'webgpu';
      }
    } catch {}

    if (onProgress) {
      onProgress({ type: 'status', text: `Loading model on ${device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}...` });
    }

    // Track per-file download progress
    const fileProgress = {};
    let totalFiles = 0;
    let completedFiles = 0;

    const pipe = await pipeline('text-generation', modelId, {
      dtype: 'q4',
      device,
      progress_callback: (progress) => {
        if (!onProgress) return;

        if (progress.status === 'initiate') {
          totalFiles++;
          fileProgress[progress.file] = { loaded: 0, total: 0, done: false };
          onProgress({
            type: 'download',
            text: `Downloading ${progress.file}...`,
            file: progress.file,
            fileProgress: 0,
            filesTotal: totalFiles,
            filesCompleted: completedFiles
          });
        } else if (progress.status === 'download') {
          if (fileProgress[progress.file]) {
            fileProgress[progress.file].loaded = progress.loaded || 0;
            fileProgress[progress.file].total = progress.total || 0;
          }
          // Calculate aggregate progress
          let totalBytes = 0;
          let loadedBytes = 0;
          for (const fp of Object.values(fileProgress)) {
            totalBytes += fp.total;
            loadedBytes += fp.done ? fp.total : fp.loaded;
          }
          const overallPct = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;
          const filePct = typeof progress.progress === 'number' ? Math.round(progress.progress) : 0;
          const sizeStr = progress.total ? ` (${formatBytes(progress.loaded)}/${formatBytes(progress.total)})` : '';

          onProgress({
            type: 'download',
            text: `Downloading model... ${overallPct}%${sizeStr}`,
            file: progress.file,
            fileProgress: filePct,
            overallProgress: overallPct,
            filesTotal: totalFiles,
            filesCompleted: completedFiles
          });
        } else if (progress.status === 'done') {
          completedFiles++;
          if (fileProgress[progress.file]) {
            fileProgress[progress.file].done = true;
          }
          onProgress({
            type: 'download',
            text: `Downloaded ${completedFiles}/${totalFiles} files...`,
            file: progress.file,
            fileProgress: 100,
            overallProgress: totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 100,
            filesTotal: totalFiles,
            filesCompleted: completedFiles
          });
        } else if (progress.status === 'loading') {
          onProgress({ type: 'status', text: 'Loading model into memory...' });
        } else if (progress.status === 'ready') {
          onProgress({ type: 'status', text: 'Model ready.' });
        }
      }
    });

    _cache = { modelId, pipe, loading: false };

    // Notify background that this model is now cached
    chrome.runtime.sendMessage({
      type: 'tjs-model-cached',
      modelId
    }).catch(() => {});

    return pipe;
  } catch (error) {
    _cache = { modelId: null, pipe: null, loading: false };
    throw error;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * Listen for messages from the service worker.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tjs-generate') {
    handleGenerate(message, sendResponse);
    return true;
  }

  if (message?.type === 'tjs-check-cache') {
    handleCheckCache(message, sendResponse);
    return true;
  }

  if (message?.type === 'tjs-delete-model') {
    handleDeleteModel(message, sendResponse);
    return true;
  }

  if (message?.type === 'tjs-download-model') {
    handleDownloadModel(message, sendResponse);
    return true;
  }

  return false;
});

async function handleDownloadModel(message, sendResponse) {
  try {
    const { modelId } = message;
    
    const sendStatus = (progress) => {
      // Send a dedicated progress message that Options page listens to
      if (progress?.type === 'download' || progress?.type === 'status') {
        chrome.runtime.sendMessage({
          type: 'tjs-download-progress',
          modelId,
          text: progress.text,
          overallProgress: progress.overallProgress || 0
        }).catch(() => {});
      }
    };

    // Load the pipeline, which downloads and caches the model
    await getPipeline(modelId, sendStatus);
    
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Model download failed.'
    });
  }
}

async function handleDeleteModel(message, sendResponse) {
  try {
    const { modelId } = message;
    if (!modelId) {
      throw new Error('Model ID is required for deletion');
    }

    // Transformers.js v3 uses a cache named 'transformers-cache' (or the default)
    const cacheNames = await caches.keys();
    let deletedCount = 0;

    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();

      for (const request of keys) {
        const url = request.url;
        // Model files have URLs containing the model ID path segments
        if (url.includes(modelId.replace('/', '%2F')) || url.includes(modelId)) {
          await cache.delete(request);
          deletedCount++;
        }
      }
    }

    // Also clear it from our active pipeline cache if it's currently loaded
    if (_cache.modelId === modelId) {
      try { await _cache.pipe?.dispose?.(); } catch {}
      _cache = { modelId: null, pipe: null, loading: false };
    }

    sendResponse({ ok: true, deletedCount });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Model deletion failed.'
    });
  }
}

let _activeGeneration = Promise.resolve();

async function handleGenerate(message, sendResponse) {
  const { requestId, modelId, messages, temperature } = message;

  // Queue up generation requests to prevent WebGPU Buffer mapAsync collisions
  // where a second generation steals the unmapped buffer of a concurrent generation.
  const previousGeneration = _activeGeneration;
  
  let releaseLock;
  _activeGeneration = new Promise(r => { releaseLock = r; });

  try {
    const sendStatus = (progress) => {
      chrome.runtime.sendMessage({
        type: 'tjs-status',
        requestId,
        ...progress
      }).catch(() => {});
    };

    // Wait for any previous generation to cleanly finish
    await previousGeneration.catch(() => {});

    const pipe = await getPipeline(modelId, sendStatus);

    sendStatus({ type: 'status', text: 'Generating answer...' });

    // Configure generation options
    const generateOptions = {
      max_new_tokens: 2048,
      temperature: Math.max(temperature || 0.2, 0.01),
      do_sample: (temperature || 0.2) > 0,
      return_full_text: false
    };

    // Provide a fallback ChatML template for models (like LFM 2.5) that may lack an explicit chat_template config
    if (!pipe.tokenizer?.chat_template) {
      generateOptions.chat_template = "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}{% if add_generation_prompt %}{{'<|im_start|>assistant\\n'}}{% endif %}";
    }

    // Stream generation sequentially to protect WebGPU context
    const output = await pipe(messages, generateOptions);

    let text = '';
    if (typeof output === 'string') {
      text = output;
    } else if (Array.isArray(output)) {
      text = output[0]?.generated_text ?? '';
    }

    // Free the pipeline lock
    releaseLock();
    sendResponse({ ok: true, text });
  } catch (error) {
    releaseLock();
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Transformers.js inference failed.'
    });
  }
}

/**
 * Check which models are present in the Transformers.js cache.
 * We check the Cache API for entries matching each model ID.
 */
async function handleCheckCache(message, sendResponse) {
  try {
    const modelIds = message.modelIds || [];
    const cached = {};

    // Transformers.js v3 uses a cache named 'transformers-cache' (or the default)
    const cacheNames = await caches.keys();
    let totalCacheSize = 0;

    for (const modelId of modelIds) {
      cached[modelId] = { downloaded: false, sizeBytes: 0, fileCount: 0 };
    }

    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();

      for (const request of keys) {
        const url = request.url;
        for (const modelId of modelIds) {
          // Model files have URLs containing the model ID path segments
          if (url.includes(modelId.replace('/', '%2F')) || url.includes(modelId)) {
            cached[modelId].downloaded = true;
            cached[modelId].fileCount++;
            try {
              const response = await cache.match(request);
              if (response) {
                const blob = await response.clone().blob();
                cached[modelId].sizeBytes += blob.size;
                totalCacheSize += blob.size;
              }
            } catch {}
          }
        }
      }
    }

    sendResponse({ ok: true, cached, totalCacheSize });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Cache check failed.'
    });
  }
}
