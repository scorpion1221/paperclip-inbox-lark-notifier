#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/ABS/PATH/TO/paperclip-inbox-lark-notifier"
CONFIG_FILE="${PAPERCLIP_INBOX_LARK_CONFIG_FILE:-$REPO_DIR/examples/inbox-lark-notifier.config.example.json}"

cd "$REPO_DIR"

export PAPERCLIP_INBOX_LARK_CONFIG_FILE="$CONFIG_FILE"
export PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY="${PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY:?missing agent api key}"
export FEISHU_APP_ID="${FEISHU_APP_ID:-${PAPERCLIP_INBOX_LARK_APP_ID:-}}"
export FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-${PAPERCLIP_INBOX_LARK_APP_SECRET:-}}"

exec pnpm start
