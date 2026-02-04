import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type { ResolvedHttpWebhookAccount } from "./accounts.js";
import type {
  HttpWebhookInboundMessage,
  UsageSummary,
  TokenUsageData,
  ModelMessage,
  TextPart,
  ImagePart,
  FilePart,
} from "./types.js";
import { getHttpWebhookRuntime } from "./runtime.js";
import { TokenTracker } from "./token-tracker.js";

export type HttpWebhookMonitorOptions = {
  account: ResolvedHttpWebhookAccount;
  config: OpenClawConfig;
  runtime: HttpWebhookRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type HttpWebhookRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type HttpWebhookCoreRuntime = ReturnType<typeof getHttpWebhookRuntime>;

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Images
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Text
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    // Video
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    // Archives
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    let resolved = false;
    const doResolve = (value: { ok: boolean; value?: unknown; error?: string }) => {
      if (resolved) return;
      resolved = true;
      req.removeAllListeners();
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        doResolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          doResolve({ ok: false, error: "empty payload" });
          return;
        }
        doResolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function validateBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (!header) return false;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return false;
  const providedToken = parts[1];

  // Constant-time comparison to prevent timing attacks
  try {
    const expectedBuffer = Buffer.from(expectedToken, "utf8");
    const providedBuffer = Buffer.from(providedToken, "utf8");
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

function logVerbose(core: HttpWebhookCoreRuntime, runtime: HttpWebhookRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[http-webhook] ${message}`);
  }
}

type ExtractedMedia = {
  url?: string;
  data?: string; // base64 encoded
  mediaType?: string;
};

type ConvertedMessages = {
  text: string;
  media: ExtractedMedia[];
};

/**
 * Converts AI SDK messages array to text and extracts media.
 * Concatenates text from all messages, prioritizing user messages.
 */
function convertMessagesToTextAndMedia(messages: ModelMessage[]): ConvertedMessages {
  const textParts: string[] = [];
  const media: ExtractedMedia[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      // System messages are prepended to provide context
      textParts.unshift(`[System: ${message.content}]`);
    } else if (message.role === "user") {
      if (typeof message.content === "string") {
        textParts.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") {
            textParts.push((part as TextPart).text);
          } else if (part.type === "image") {
            const imagePart = part as ImagePart;
            const extracted = extractMediaFromPart(imagePart.image, imagePart.mediaType);
            if (extracted) media.push(extracted);
          } else if (part.type === "file") {
            const filePart = part as FilePart;
            const extracted = extractMediaFromPart(filePart.data, filePart.mediaType);
            if (extracted) media.push(extracted);
          }
        }
      }
    } else if (message.role === "assistant") {
      // Assistant messages are included for context
      textParts.push(`[Assistant: ${message.content}]`);
    }
    // Tool messages are skipped as they're typically internal
  }

  return {
    text: textParts.join("\n").trim(),
    media,
  };
}

/**
 * Extracts media info from a part's data field.
 * Handles URLs, base64 strings, and data URLs.
 */
function extractMediaFromPart(
  data: string | Uint8Array | ArrayBuffer | URL,
  mediaType?: string,
): ExtractedMedia | null {
  if (data instanceof URL) {
    return { url: data.toString(), mediaType };
  }
  if (typeof data === "string") {
    // Check if it's a URL
    if (data.startsWith("http://") || data.startsWith("https://")) {
      return { url: data, mediaType };
    }
    // Check if it's a data URL
    if (data.startsWith("data:")) {
      const match = data.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
      if (match) {
        const detectedMediaType = match[1] || mediaType;
        const base64Data = match[2];
        return { data: base64Data, mediaType: detectedMediaType };
      }
    }
    // Assume it's base64 encoded
    return { data, mediaType };
  }
  // Handle binary data (Uint8Array, ArrayBuffer)
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const base64 = Buffer.from(bytes).toString("base64");
    return { data: base64, mediaType };
  }
  return null;
}

async function processInboundMessage(params: {
  message: HttpWebhookInboundMessage;
  account: ResolvedHttpWebhookAccount;
  config: OpenClawConfig;
  runtime: HttpWebhookRuntimeEnv;
  core: HttpWebhookCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tokenTracker?: TokenTracker;
}): Promise<void> {
  const { message, account, config, runtime, core, statusSink, tokenTracker } = params;

  const from = message.from.trim();
  const fromName = message.fromName?.trim() || from;

  // Handle either 'text' or 'messages' array (AI SDK format)
  let text: string;
  let extractedMedia: ExtractedMedia[] = [];

  if ("messages" in message && message.messages) {
    const converted = convertMessagesToTextAndMedia(message.messages);
    text = converted.text;
    extractedMedia = converted.media;
  } else {
    text = (message.text ?? "").trim();
  }

  if (!from || !text) {
    logVerbose(core, runtime, "skip message with missing from or text");
    return;
  }

  // Check DM policy
  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const allowFrom = account.config.dm?.allowFrom ?? [];
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(text, config);
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await core.channel.pairing.readAllowFromStore("http-webhook").catch(() => [])
      : [];
  const effectiveAllowFrom = [...allowFrom, ...storeAllowFrom];
  const senderAllowed = effectiveAllowFrom.includes("*") || effectiveAllowFrom.includes(from);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: config.commands?.useAccessGroups !== false,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      })
    : undefined;

  if (dmPolicy === "disabled" || account.config.dm?.enabled === false) {
    logVerbose(runtime, runtime, `Blocked HTTP webhook message from ${from} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    if (!senderAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "http-webhook",
          id: from,
          meta: { name: fromName },
        });
        if (created) {
          logVerbose(core, runtime, `http-webhook pairing request sender=${from}`);
          // Send pairing reply via outbound webhook
          try {
            const { sendHttpWebhookMessage } = await import("./api.js");
            await sendHttpWebhookMessage({
              account,
              message: {
                text: core.channel.pairing.buildPairingReply({
                  channel: "http-webhook",
                  idLine: `Your user id: ${from}`,
                  code,
                }),
                to: from,
                timestamp: Date.now(),
              },
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logVerbose(core, runtime, `pairing reply failed for ${from}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(
          core,
          runtime,
          `Blocked unauthorized HTTP webhook sender ${from} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "http-webhook",
    accountId: account.accountId,
    peer: {
      kind: "dm",
      id: from,
    },
  });

  // Download/save media if provided (from mediaUrl or messages array)
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;

  // Handle mediaUrl from the message
  if (message.mediaUrl) {
    try {
      const loaded = await core.channel.media.fetchRemoteMedia(message.mediaUrl, { maxBytes });
      const saved = await core.channel.media.saveMediaBuffer(
        loaded.buffer,
        loaded.contentType,
        "inbound",
        maxBytes,
        loaded.filename,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
      mediaPaths.push(saved.path);
      mediaTypes.push(saved.contentType);
    } catch (err) {
      runtime.error?.(`Failed downloading media: ${String(err)}`);
    }
  }

  // Handle media from messages array (AI SDK format)
  for (const extracted of extractedMedia) {
    try {
      if (extracted.url) {
        // Remote URL - download it
        const loaded = await core.channel.media.fetchRemoteMedia(extracted.url, { maxBytes });
        const saved = await core.channel.media.saveMediaBuffer(
          loaded.buffer,
          loaded.contentType,
          "inbound",
          maxBytes,
          loaded.filename,
        );
        if (!mediaPath) {
          mediaPath = saved.path;
          mediaType = saved.contentType;
        }
        mediaPaths.push(saved.path);
        mediaTypes.push(saved.contentType);
      } else if (extracted.data) {
        // Base64 data - decode and save
        const buffer = Buffer.from(extracted.data, "base64");
        const contentType = extracted.mediaType ?? "application/octet-stream";
        const saved = await core.channel.media.saveMediaBuffer(
          buffer,
          contentType,
          "inbound",
          maxBytes,
        );
        if (!mediaPath) {
          mediaPath = saved.path;
          mediaType = saved.contentType;
        }
        mediaPaths.push(saved.path);
        mediaTypes.push(saved.contentType);
      }
    } catch (err) {
      runtime.error?.(`Failed processing media from messages: ${String(err)}`);
    }
  }

  // Build context payload
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "HTTP Webhook",
    from: fromName,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: `http-webhook:${from}`,
    To: `http-webhook:${account.accountId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromName,
    SenderName: fromName,
    SenderId: from,
    CommandAuthorized: commandAuthorized,
    Provider: "http-webhook",
    Surface: "http-webhook",
    MessageSid: message.messageId,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    // Include additional media paths/types for multi-media messages
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    OriginatingChannel: "http-webhook",
    OriginatingTo: `http-webhook:${from}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`http-webhook: failed updating session meta: ${String(err)}`);
    });

  // Dispatch reply
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverHttpWebhookReply({
          payload,
          account,
          to: from,
          runtime,
          core,
          config,
          statusSink,
          tokenTracker,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] HTTP webhook ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function loadUsageSummary(runtime: HttpWebhookRuntimeEnv): Promise<UsageSummary | undefined> {
  try {
    // Import loadProviderUsageSummary from openclaw plugin SDK
    const { loadProviderUsageSummary } = await import("openclaw/plugin-sdk");
    const summary = await loadProviderUsageSummary();
    return summary;
  } catch (err) {
    runtime.error?.(`HTTP webhook: failed to load usage summary: ${String(err)}`);
    return undefined;
  }
}

async function deliverHttpWebhookReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedHttpWebhookAccount;
  to: string;
  runtime: HttpWebhookRuntimeEnv;
  core: HttpWebhookCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tokenTracker?: TokenTracker;
}): Promise<void> {
  const { payload, account, to, runtime, core, config, statusSink, tokenTracker } = params;
  const { sendHttpWebhookMessage } = await import("./api.js");

  // Load current usage summary
  const usage = await loadUsageSummary(runtime);

  // Get token usage data if tracker is available
  const tokens: TokenUsageData | undefined = tokenTracker?.getData();

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    // Send media messages
    for (const mediaUrl of mediaList) {
      // Skip undefined or empty URLs
      if (!mediaUrl) {
        runtime.error?.(`HTTP webhook: skipping undefined/empty mediaUrl`);
        continue;
      }

      try {
        // Check if it's a remote URL (http/https) or local file path
        const isRemoteUrl = mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://');

        if (!isRemoteUrl) {
          // Local file path - read the file and send as base64
          try {
            const fileBuffer = await readFile(mediaUrl);
            const base64Data = fileBuffer.toString('base64');
            const mediaType = getMimeTypeFromExtension(mediaUrl);
            const filename = mediaUrl.split('/').pop() || 'file';

            runtime.log?.(`HTTP webhook: sending local file "${mediaUrl}" as base64 (${fileBuffer.length} bytes, ${mediaType})`);

            await sendHttpWebhookMessage({
              account,
              message: {
                text: payload.text || "",
                to,
                files: [{
                  data: base64Data,
                  mediaType,
                  filename,
                }],
                timestamp: Date.now(),
                usage,
                tokens,
              },
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (fileErr) {
            runtime.error?.(
              `HTTP webhook: failed to read local file "${mediaUrl}": ${String(fileErr)}`
            );
            // Send text-only message as fallback
            if (payload.text) {
              await sendHttpWebhookMessage({
                account,
                message: {
                  text: payload.text,
                  to,
                  timestamp: Date.now(),
                  usage,
                  tokens,
                },
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            }
          }
          continue;
        }

        // It's a remote URL - download and convert to base64
        try {
          runtime.log?.(`HTTP webhook: downloading remote URL "${mediaUrl}" to send as base64`);
          const response = await fetch(mediaUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString('base64');
          const contentType = response.headers.get('content-type') || getMimeTypeFromExtension(mediaUrl);
          const filename = mediaUrl.split('/').pop()?.split('?')[0] || 'file';

          runtime.log?.(`HTTP webhook: sending remote file as base64 (${arrayBuffer.byteLength} bytes, ${contentType})`);

          await sendHttpWebhookMessage({
            account,
            message: {
              text: payload.text || "",
              to,
              files: [{
                data: base64Data,
                mediaType: contentType,
                filename,
              }],
              timestamp: Date.now(),
              usage,
              tokens,
            },
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (fetchErr) {
          runtime.error?.(`HTTP webhook: failed to download remote URL "${mediaUrl}": ${String(fetchErr)}`);
          // Send text-only message as fallback
          if (payload.text) {
            await sendHttpWebhookMessage({
              account,
              message: {
                text: payload.text,
                to,
                timestamp: Date.now(),
                usage,
                tokens,
              },
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        }
      } catch (err) {
        runtime.error?.(`HTTP webhook media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (payload.text) {
    // Send text message
    const chunkLimit = account.config.textChunkLimit ?? 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "http-webhook", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendHttpWebhookMessage({
          account,
          message: {
            text: chunk,
            to,
            timestamp: Date.now(),
            usage,
            tokens,
          },
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`HTTP webhook message send failed: ${String(err)}`);
      }
    }
  }
}

export async function startHttpWebhookMonitor(
  options: HttpWebhookMonitorOptions,
): Promise<() => void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getHttpWebhookRuntime();

  const inbound = account.config.inbound;
  if (!inbound?.token) {
    runtime.error?.(`[${account.accountId}] inbound.token not configured`);
    return () => {};
  }

  const port = inbound.port ?? 5000;
  const path = normalizeWebhookPath(inbound.path ?? "/");
  const token = inbound.token;
  const healthPath = "/health";

  // Create and initialize token tracker
  const stateDir = config.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR ?? process.env.HOME + "/.openclaw";
  const tokenDataPath = `${stateDir}/http-webhook-tokens.json`;
  const tokenTracker = new TokenTracker({
    dataPath: tokenDataPath,
    autosaveIntervalMs: 30000, // Save every 30 seconds
  });

  try {
    await tokenTracker.load();
    runtime.log?.(`[${account.accountId}] Token tracker loaded from ${tokenDataPath}`);
  } catch (err) {
    runtime.error?.(`[${account.accountId}] Token tracker load failed: ${String(err)}`);
  }

  tokenTracker.start();
  runtime.log?.(`[${account.accountId}] Token tracker started`);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    // Webhook handler
    if (req.url !== path) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Allow": "POST" });
      res.end("Method Not Allowed");
      return;
    }

    // Validate bearer token (check X-EZAIL-Authorization first, then fall back to Authorization)
    const ezailAuthHeader = req.headers["x-ezail-authorization"] as string | undefined;
    const authHeader = ezailAuthHeader ?? req.headers.authorization;
    if (!validateBearerToken(authHeader, token)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    // Parse JSON body
    void readJsonBody(req, 1024 * 1024).then(async (body) => {
      if (!body.ok) {
        res.statusCode = body.error === "payload too large" ? 413 : 400;
        res.end(body.error ?? "Invalid payload");
        return;
      }

      const rawMessage = body.value as Record<string, unknown>;
      if (!rawMessage || typeof rawMessage !== "object" || !rawMessage.from) {
        res.statusCode = 400;
        res.end("Invalid message format: missing 'from' field");
        return;
      }

      // Validate that either 'text' or 'messages' is provided
      const hasText = typeof rawMessage.text === "string" && rawMessage.text.trim().length > 0;
      const hasMessages = Array.isArray(rawMessage.messages) && rawMessage.messages.length > 0;

      if (!hasText && !hasMessages) {
        res.statusCode = 400;
        res.end("Invalid message format: must provide either 'text' or 'messages' array");
        return;
      }

      const message = rawMessage as HttpWebhookInboundMessage;

      statusSink?.({ lastInboundAt: Date.now() });

      // Return 200 immediately, process async
      res.writeHead(200);
      res.end("OK");

      // Process message asynchronously
      processInboundMessage({
        message,
        account,
        config,
        runtime,
        core,
        statusSink,
        tokenTracker,
      }).catch((err) => {
        runtime.error?.(`[${account.accountId}] HTTP webhook processing failed: ${String(err)}`);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  runtime.log?.(`[${account.accountId}] HTTP webhook listening on port ${port}${path}`);

  const shutdown = () => {
    tokenTracker.stop();
    runtime.log?.(`[${account.accountId}] Token tracker stopped`);
    server.close();
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return shutdown;
}
