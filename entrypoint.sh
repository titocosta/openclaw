#!/bin/sh
set -e

# Ensure extensions directory exists and plugin is linked
if [ ! -d /data/extensions ]; then
  echo "Creating extensions directory"
  mkdir -p /data/extensions
fi

if [ ! -e /data/extensions/http-webhook ]; then
  echo "Linking http-webhook plugin"
  ln -s /root/.openclaw/extensions/http-webhook /data/extensions/http-webhook
fi

if [ ! -f /data/openclaw.json ]; then
  echo "Initializing openclaw config"
  cp /defaults/openclaw.json /data/openclaw.json

  # Substitute environment variables in config
  if [ -n "$HTTP_WEBHOOK_INBOUND_TOKEN" ]; then
    echo "Setting inbound token to ${HTTP_WEBHOOK_INBOUND_TOKEN}"
    sed -i "s/\${HTTP_WEBHOOK_INBOUND_TOKEN}/$HTTP_WEBHOOK_INBOUND_TOKEN/g" /data/openclaw.json
  else
    echo "HTTP_WEBHOOK_INBOUND_TOKEN env var is not set"
  fi

  if [ -n "$HTTP_WEBHOOK_OUTBOUND_URL" ]; then
    echo "Setting outbound url to ${HTTP_WEBHOOK_OUTBOUND_URL}"
    sed -i "s|\${HTTP_WEBHOOK_OUTBOUND_URL}|$HTTP_WEBHOOK_OUTBOUND_URL|g" /data/openclaw.json
  else
    echo "HTTP_WEBHOOK_OUTBOUND_URL env var is not set"
  fi

  if [ -n "$HTTP_WEBHOOK_OUTBOUND_TOKEN" ]; then
    echo "Setting outbound token to ${HTTP_WEBHOOK_OUTBOUND_TOKEN}"
    sed -i "s/\${HTTP_WEBHOOK_OUTBOUND_TOKEN}/$HTTP_WEBHOOK_OUTBOUND_TOKEN/g" /data/openclaw.json
  else
    echo "HTTP_WEBHOOK_OUTBOUND_TOKEN env var is not set"
  fi
else
  echo "OpenClaw config already exists at /data/openclaw.json!"
fi

exec node /app/dist/index.js gateway --port 3000 --bind lan --allow-unconfigured
