# HTTP Webhook Channel Plugin

Simple HTTP webhook channel plugin for OpenClaw that accepts incoming messages via POST requests and sends responses to a remote webhook URL, using bearer token authentication for both directions.

## Features

- **Inbound**: Accept POST requests on configurable port and path
- **Outbound**: Send messages to remote webhook URL
- **Authentication**: Bearer token authentication for both inbound and outbound requests
- **Single-account**: One account per gateway (simplified design)
- **Media support**: Download and send media attachments via URLs
- **Pairing support**: Built-in pairing flow for user authentication

## Installation

```bash
openclaw plugin install extensions/http-webhook
```

## Configuration

Add the following to your `~/.openclaw/config.json`:

```json
{
  "channels": {
    "http-webhook": {
      "enabled": true,
      "inbound": {
        "port": 5000,
        "path": "/",
        "token": "your-secret-inbound-token-here"
      },
      "outbound": {
        "url": "https://your-server.com/api/webhook",
        "token": "your-secret-outbound-token-here",
        "timeoutSeconds": 30
      },
      "dm": {
        "policy": "open",
        "allowFrom": ["*"]
      }
    }
  }
}
```

### Configuration Options

#### `inbound`
- `port` (number, default: 5000): Port for the HTTP server to listen on
- `path` (string, default: "/"): URL path for webhook endpoint
- `token` (string, required): Bearer token for authenticating incoming requests

#### `outbound`
- `url` (string, required): Remote webhook URL to send messages to
- `token` (string, required): Bearer token for authenticating outgoing requests
- `timeoutSeconds` (number, default: 30): Request timeout in seconds

#### `dm`
- `policy` (string, default: "pairing"): DM policy - "open", "pairing", or "allowlist"
- `allowFrom` (array, optional): List of allowed user IDs (use "*" for open access)

#### Other Options
- `mediaMaxMb` (number, default: 20): Maximum media file size in MB
- `textChunkLimit` (number, default: 4000): Maximum text message length

## Message Formats

### Inbound (POST to local server)

```json
{
  "text": "message content",
  "from": "sender-id",
  "fromName": "Sender Name",
  "mediaUrl": "https://example.com/image.jpg",
  "messageId": "msg-123",
  "timestamp": 1234567890000
}
```

Required headers:
- `Authorization: Bearer <inbound-token>`
- `Content-Type: application/json`

### Outbound (POST to remote server)

```json
{
  "text": "response content",
  "to": "recipient-id",
  "mediaUrl": "https://example.com/image.jpg",
  "timestamp": 1234567890000
}
```

Headers sent:
- `Authorization: Bearer <outbound-token>`
- `Content-Type: application/json`

## Usage

### Starting the Gateway

```bash
openclaw gateway run
```

The HTTP webhook server will start automatically on the configured port.

### Health Check

```bash
curl http://localhost:5000/health
```

### Sending a Test Message

```bash
curl -X POST http://localhost:5000/ \
  -H "Authorization: Bearer your-inbound-token" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello from webhook",
    "from": "user-123",
    "fromName": "Test User"
  }'
```

### Sending Outbound Messages

```bash
openclaw message send --channel http-webhook --to user-123 "Hello!"
```

### Channel Status

```bash
openclaw channels status
openclaw channels status --deep
```

## DM Policies

### Open
Allow messages from anyone (requires `allowFrom: ["*"]`):
```json
"dm": {
  "policy": "open",
  "allowFrom": ["*"]
}
```

### Pairing (default)
Require users to pair before messaging:
```json
"dm": {
  "policy": "pairing"
}
```

Approve pairing requests:
```bash
openclaw pairing list
openclaw pairing approve --channel http-webhook --id user-123
```

### Allowlist
Only allow specific users:
```json
"dm": {
  "policy": "allowlist",
  "allowFrom": ["user-123", "user-456"]
}
```

## Security

- Bearer tokens are validated using constant-time comparison to prevent timing attacks
- Request size limited to 1MB
- Configurable timeouts prevent hanging connections
- Tokens are never logged
- Tokens are marked as sensitive in configuration

## Troubleshooting

### Server not starting
- Check if port is already in use: `lsof -i :5000`
- Verify inbound.token is configured
- Check gateway logs for errors

### Messages not received
- Verify bearer token is correct
- Check Content-Type header is `application/json`
- Confirm request body format matches schema
- Test health endpoint: `curl http://localhost:5000/health`

### Messages not sent
- Verify outbound.url and outbound.token are configured
- Check remote webhook is reachable
- Review gateway logs for HTTP errors
- Test with `openclaw channels status --deep`

## Development

Build the plugin:
```bash
pnpm build
```

Run tests:
```bash
pnpm test
```

## License

Part of the OpenClaw project.
