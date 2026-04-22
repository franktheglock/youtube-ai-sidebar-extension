# YouTube AI Sidebar Extension

A Chrome extension that adds an AI chat sidebar directly to YouTube watch pages.

It pulls the current video's transcript, streams answers in place, links timestamp mentions back to the player, and can enrich answers with lightweight web context when the user asks for outside information.

## Features

- Transcript-grounded answers for the current YouTube video
- Inline timestamp citations like `[03:14]` or `【03:14】` that jump the video player
- Streamed responses in the sidebar UI
- Suggested starter questions for each video
- Optional web context via:
	- `web_search` against a SearxNG instance
	- `read_url` for pasted URLs in prompts
- Support for multiple model providers:
	- OpenRouter
	- LM Studio
	- NVIDIA NIM

## How It Works

1. The content script injects a sidebar into YouTube watch pages.
2. The extension fetches and normalizes transcript data for the current video.
3. User questions are sent to the background worker.
4. The background worker can optionally gather web context, then streams the final answer back into the sidebar.
5. Transcript timestamps and source citations are rendered as interactive UI elements.

## Project Structure

```text
src/
	background.js   Background worker and model orchestration
	content.js      YouTube sidebar UI and interaction logic
	options.js      Extension options page logic
build.mjs         esbuild bundling script
manifest.json     Chrome extension manifest
options.html      Options page markup
icons/            Extension icons
```

## Local Development

Install dependencies and build the extension:

```bash
npm install
npm run build
```

Load the workspace root as an unpacked extension in Chrome:

```text
R:\youtube extension\extension
```

After code changes, rebuild before reloading the extension in Chrome.

## Configuration

Open the extension options page and configure:

- Provider
- Model name
- Base URL
- API key, when required
- SearxNG base URL

Default SearxNG URL:

```text
http://192.168.1.70:8888
```

## Citation Behavior

- Transcript-backed claims are instructed to cite timestamps such as `[03:14]`
- Web-backed claims are instructed to cite numeric sources such as `[1]`
- Citation pills render the source number plus the site's favicon
- Timestamp links are converted into clickable seek actions in the player

## Publishing Notes

Before pushing to GitHub or shipping the extension:

- Build once so the unpacked extension is ready to load locally
- Keep API keys in the extension options storage, not in source files
- Do not commit `node_modules/` or generated root build files

## License

No license file has been added yet. If you plan to make the repository public, add one before publishing.