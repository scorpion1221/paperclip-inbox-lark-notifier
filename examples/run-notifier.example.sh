#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/ABS/PATH/TO/paperclip-inbox-lark-notifier"
BASE_DIR="${BASE_DIR:-$HOME/.config/paperclip-inbox-lark-notifier}"
SERVICE_ENV_FILE="$BASE_DIR/service.env"
CONFIG_FILE="${PAPERCLIP_INBOX_LARK_CONFIG_FILE:-$REPO_DIR/examples/inbox-lark-notifier.config.example.json}"

if [ -f "$SERVICE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SERVICE_ENV_FILE"
  set +a
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm use --silent default >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH; install Homebrew Node or configure an nvm default version" >&2
  exit 127
fi

cd "$REPO_DIR"

export PAPERCLIP_INBOX_LARK_CONFIG_FILE="$CONFIG_FILE"
if [ -n "${PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY:-}" ]; then
  export PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY
fi
if [ -n "${FEISHU_APP_ID:-${LARK_APP_ID:-${PAPERCLIP_INBOX_LARK_APP_ID:-}}}" ]; then
  export FEISHU_APP_ID="${FEISHU_APP_ID:-${LARK_APP_ID:-${PAPERCLIP_INBOX_LARK_APP_ID:-}}}"
fi
if [ -n "${FEISHU_APP_SECRET:-${LARK_APP_SECRET:-${PAPERCLIP_INBOX_LARK_APP_SECRET:-}}}" ]; then
  export FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-${LARK_APP_SECRET:-${PAPERCLIP_INBOX_LARK_APP_SECRET:-}}}"
fi

exec pnpm start
