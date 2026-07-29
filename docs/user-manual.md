# TRAECNclaw User Manual

## Purpose

TRAECNclaw lets OpenClaw and local HTTP clients delegate tasks to the TraeCN desktop application. It drives TraeCN through CDP and DOM automation, then returns the response text through a local API or the built-in web chat.

## First Run

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `TRAECN_BIN` if TraeCN is not installed in a default location.
4. Start TraeCN with CDP enabled by running `npm run quickstart`, or start TraeCN manually with `--remote-debugging-port=9222`.
5. Start the gateway with `npm run start:gateway`.
6. Open `http://127.0.0.1:8788/`.

## Chat UI

The chat UI creates a session and sends each task through `/api/sessions/{sessionId}/delegate`. If `TRAECN_GATEWAY_TOKEN` is set, enter the token in the header and select `Save`. The token is stored in local browser storage for that browser profile.

## OpenClaw Plugin

The OpenClaw plugin lives in `integrations/openclaw-traecn-plugin`. It registers
27 wrapper tools (full list in `openclaw.plugin.json`), including the most-used:

- `traecn_capabilities`, `traecn_command_set`, `traecn_preflight`,
  `traecn_command`, `traecn_plan_operation`
- `traecn_status`, `traecn_new_chat`, `traecn_delegate`, `traecn_task_status`,
  `traecn_cancel_task`, `traecn_vibe_workflow`
- `traecn_switch_mode`, `traecn_switch_model`, `traecn_queue_status`,
  `traecn_open_project`
- `traecn_settings_action`, `traecn_settings_read`, `traecn_settings_set`
- `traecn_dialog_status`, `traecn_approve`
- `traecn_cleanup_queue`, `traecn_cleanup_watch_status`
- `traecn_long_queue_proof_start`, `traecn_long_queue_proof_status`,
  `traecn_long_queue_proof_cancel`
- `traecn_chat`, `traecn_update_self`

Use `traecn_delegate` when you need a returned TraeCN response. Use `traecn_chat`
only for fire-and-forget CLI tasks. Use `traecn_command` with the
`traecn_command_set` catalog when you want stable command IDs instead of
per-tool wrappers.

## Troubleshooting

- If `/api/status` is disconnected, confirm TraeCN is running and that `TRAECN_REMOTE_DEBUGGING_PORT` matches the app's CDP port.
- If a delegate call fails with selector errors, run `npm run inspect:traecn` and copy the reported selectors into `.env`.
- If the browser reports unauthorized errors, set the token in the chat UI or pass `Authorization: Bearer <token>`.
- If requests are blocked by CORS, set `TRAECN_ALLOWED_ORIGINS` to the exact browser origin.

## Acceptance Checklist

- Gateway starts on `127.0.0.1`.
- `/api/status` returns JSON.
- Built-in chat UI can create a session and send a mock or live task.
- OpenClaw plugin can call `traecn_status` and `traecn_delegate`.
- `npm run test:system` passes in mock mode.
