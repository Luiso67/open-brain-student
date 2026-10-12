#!/bin/bash
# Points your Telegram bot at your telegram-bot edge function, with a secret
# header so only Telegram can call it. Your bot token is typed here, hidden,
# and is never saved to disk or shown on screen.
set -euo pipefail

PROJECT_REF="vmdrvujkzlvpuzzttfxg"
FUNCTION_URL="https://${PROJECT_REF}.supabase.co/functions/v1/telegram-bot"

printf "Copy your bot token from BotFather, then just press Enter here (or paste it first, it stays hidden): "
read -rs TOKEN
echo
if [[ -z "$TOKEN" ]]; then
  TOKEN=$(pbpaste | tr -d '[:space:]')
fi
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "That does not look like a bot token. Copy the token in Telegram again and rerun. Nothing was changed."
  exit 1
fi

# Same derivation as webhookSecret() in supabase/functions/telegram-bot/index.ts
SECRET=$(printf '%s' "open-brain-webhook:${TOKEN}" | shasum -a 256 | cut -c1-48)

RESULT=$(curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${FUNCTION_URL}" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message"]' \
  --data-urlencode "drop_pending_updates=true")
unset TOKEN SECRET
printf "" | pbcopy  # clear the token off the clipboard

if echo "$RESULT" | grep -q '"ok":true'; then
  echo "Done. Telegram will now send your bot's messages to your brain."
else
  echo "Telegram said: $RESULT"
  exit 1
fi
