# Paperclip Inbox Lark Notifier

Standalone notifier that watches Paperclip live issue activity and sends Lark cards when a configured board user's Mine inbox gains a newly visible issue.

It depends only on:

- public Paperclip HTTP and WebSocket APIs
- Lark webhook or direct Feishu IM APIs

It does not import anything from the Paperclip monorepo.

## What It Does

- connects to `GET /api/companies/:companyId/events/ws` with an agent API key
- listens for `activity.logged` issue actions:
  - `issue.created`
  - `issue.updated`
  - `issue.comment_added`
  - `issue.read_marked`
  - `issue.read_unmarked`
  - `issue.inbox_archived`
  - `issue.inbox_unarchived`
- refetches `GET /api/agents/me/inbox/mine?userId=:userId` for configured users
- diffs inbox snapshots and sends cards only for newly visible issues
- suppresses duplicate notifications for local read/archive inbox actions
- retries transient HTTP failures and reconnects after websocket disconnects

## Requirements

- Node.js 20+
- pnpm 9+
- a long-lived Paperclip agent API key
- a Lark destination for each Paperclip user you want to notify

## Install

```sh
pnpm install
```

## Quickstart

1. Copy the example config:

```sh
cp examples/inbox-lark-notifier.config.example.json ./notifier.config.json
```

2. Edit `apiUrl`, `companyId`, `paperclipBaseUrl`, and `destinationsByUserId`.

3. Export secrets:

```sh
export PAPERCLIP_INBOX_LARK_CONFIG_FILE="$PWD/notifier.config.json"
export PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY="pcak_..."
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

4. Start the notifier:

```sh
pnpm start
```

The notifier accepts all of the following credential env names for direct `open_id` / `chat_id` delivery:

- `PAPERCLIP_INBOX_LARK_APP_ID` / `PAPERCLIP_INBOX_LARK_APP_SECRET`
- `LARK_APP_ID` / `LARK_APP_SECRET`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`

Use webhook-only destinations if you want to skip app credentials entirely.

## Config Modes

### Single config file

Put everything into one JSON file and point `PAPERCLIP_INBOX_LARK_CONFIG_FILE` at it.

Example: [examples/inbox-lark-notifier.config.example.json](./examples/inbox-lark-notifier.config.example.json)

### Split config and destinations

Keep shared runtime settings in one file and user mappings in another:

```sh
export PAPERCLIP_INBOX_LARK_CONFIG_FILE="$PWD/notifier.config.json"
export PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE="$PWD/destinations.json"
export PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY="pcak_..."
pnpm start
```

Example destinations file: [examples/inbox-lark-destinations.example.json](./examples/inbox-lark-destinations.example.json)

### Env override rules

Environment variables override file values. The main env vars are:

- `PAPERCLIP_INBOX_NOTIFIER_API_URL`
- `PAPERCLIP_INBOX_NOTIFIER_BASE_URL`
- `PAPERCLIP_INBOX_NOTIFIER_COMPANY_ID`
- `PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY`
- `PAPERCLIP_INBOX_LARK_CONFIG_FILE`
- `PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE`
- `PAPERCLIP_INBOX_LARK_DESTINATIONS_JSON`
- `PAPERCLIP_INBOX_LARK_APP_ID`
- `PAPERCLIP_INBOX_LARK_APP_SECRET`
- `PAPERCLIP_INBOX_LARK_DRY_RUN`
- `PAPERCLIP_INBOX_LARK_LOG_LEVEL`

## Supported Destination Types

- `webhook`: send an interactive card through a Lark custom bot webhook
- `open_id`: send through the direct Feishu IM API to a user open id
- `chat_id`: send through the direct Feishu IM API to a chat id

For `open_id` and `chat_id`, export one of the supported app credential pairs listed above.

The direct-send path follows the same tenant-token + `POST /open-apis/im/v1/messages` flow as the user-provided Feishu example. The notifier now emits a Feishu Card 2.0 payload with:

- a status-colored header
- a dedicated summary block
- a reply-detail block for `issue.comment_added` notifications
- a separate metadata block with compact, scan-friendly labels
- no read/unread badge noise in the card chrome

## Smoke Validation

This repo includes a safe local smoke path that mocks both Paperclip and Lark:

```sh
pnpm smoke
```

It starts a local fake Paperclip API and WebSocket server, emits one inbox-visible issue event, and verifies that exactly one Lark webhook card is delivered.

## Acceptance Validation

For the full repeatable acceptance path, run:

```sh
pnpm acceptance
```

It uses the same fake Paperclip pattern plus fake Lark endpoints to verify all three card templates (`issue.created`, `issue.updated`, `issue.comment_added`) across both webhook delivery and direct IM delivery.

## Tests

```sh
pnpm typecheck
pnpm test
pnpm smoke
pnpm acceptance
```

## Dry Run

```sh
export PAPERCLIP_INBOX_LARK_DRY_RUN=true
pnpm start
```

In dry-run mode, cards are logged but not delivered.

## Self-Hosted Deployment

Recommended production shape:

1. Run the notifier as a long-lived process.
2. Give it a dedicated long-lived Paperclip agent API key.
3. Keep Lark credentials in environment variables or your secret manager.
4. Version the non-secret config file in git.

Example templates:

- [launchd template](./examples/inbox-lark-notifier.launchd.plist)
- [systemd template](./examples/inbox-lark-notifier.systemd.service)
- [shell wrapper](./examples/run-notifier.example.sh)

For macOS `launchd`, prefer running the wrapper script instead of invoking `pnpm start`
directly from the plist. GUI launch agents often start with a minimal `PATH`, which can
make `pnpm` fail with `env: node: No such file or directory` when Node is managed by nvm.

## Notification Semantics

- bootstrap and reconnect refreshes update local snapshots without sending historical notifications
- shared issue activity notifies when an issue becomes newly visible in the target inbox
- local read/archive actions refresh the right user snapshot but do not generate duplicate cards

## Development Notes

- entrypoint: [src/index.ts](./src/index.ts)
- core logic: [src/notifier.ts](./src/notifier.ts)
- unit tests: [test/notifier.test.ts](./test/notifier.test.ts)
- acceptance flow: [scripts/acceptance.ts](./scripts/acceptance.ts)
- smoke flow: [scripts/smoke.ts](./scripts/smoke.ts)
