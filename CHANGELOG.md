# Changelog

All notable changes to gxAgent are documented in this file.

## Unreleased

### Added

- Added image attachments for chat prompts, including paste, file picker, drag-and-drop, preview chips, and user-message thumbnails.
- Added multimodal request support for OpenAI-compatible APIs and Ollama image-capable models.
- Added search modes for chat input: off, auto, and force.
- Added structured search source metadata for frontend display and activity-panel source lists.
- Added GitHub Actions CI for frontend build and Rust backend checks.

### Changed

- Reworked settings into focused tabs for model/API, chat experience, agent tools, search, and data.
- Improved search follow-up prompts to avoid duplicate injected instructions.
- Updated config-related Tauri commands to receive the current frontend config explicitly.
- Improved DuckDuckGo fallback behavior to use Tavily when a fallback API key is configured.

### Fixed

- Fixed force-search failures so they stop early instead of sending an answer request without usable search results.
- Fixed settings modal close behavior when selecting text inside the modal.
- Fixed search follow-up tool message ordering for DSML-style search calls.
- Fixed file-browser command errors so they propagate as Tauri command failures.
