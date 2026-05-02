# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added production documentation covering usage, development, deployment, environment configuration, and release acceptance checks.
- Added mock-mode system testing and documentation/OpenAPI UAT validation scripts.
- Added explicit OpenAPI coverage for settings read/write and self-update status endpoints.

### Changed

- Improved gateway response headers, CORS handling, status version reporting, numeric environment parsing, and background queue polling lifecycle.
- Improved the built-in chat UI with safer DOM rendering, clearer error handling, responsive layout, token persistence, and status metadata.
- Updated OpenClaw plugin metadata to match registered tools.

### Fixed

- Fixed plugin client settings API paths to match gateway routes.
- Added `/api/delegate-async` compatibility for async delegation clients.
- Added mock queue status support so mock-mode delegate flows work through the async path.

### Security

- Added timing-safe token comparison and removed the identifying `X-Powered-By` response header.
- Added security headers for JSON and HTML responses and response-size protection in the plugin HTTP client.
