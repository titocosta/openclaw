import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  getChatChannelMeta,
  missingTargetError,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";

import {
  listHttpWebhookAccountIds,
  resolveDefaultHttpWebhookAccountId,
  resolveHttpWebhookAccount,
  type ResolvedHttpWebhookAccount,
} from "./accounts.js";
import { sendHttpWebhookMessage, probeHttpWebhook } from "./api.js";
import { getHttpWebhookRuntime } from "./runtime.js";
import { startHttpWebhookMonitor } from "./monitor.js";
import { HttpWebhookConfigSchema } from "./types.config.js";

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

const meta = getChatChannelMeta("http-webhook");

const formatAllowFromEntry = (entry: string) => entry.trim();

export const httpWebhookPlugin: ChannelPlugin<ResolvedHttpWebhookAccount> = {
  id: "http-webhook",
  meta: { ...meta },
  pairing: {
    idLabel: "userId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveHttpWebhookAccount({ cfg: cfg as OpenClawConfig });
      if (account.credentialSource === "none") return;
      await sendHttpWebhookMessage({
        account,
        message: {
          text: PAIRING_APPROVED_MESSAGE,
          to: id,
          timestamp: Date.now(),
        },
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.http-webhook"] },
  configSchema: {
    schema: HttpWebhookConfigSchema.shape,
    uiHints: {
      "inbound.token": { sensitive: true, label: "Inbound Bearer Token" },
      "outbound.token": { sensitive: true, label: "Outbound Bearer Token" },
      "outbound.url": { label: "Outbound Webhook URL" },
      "inbound.port": { label: "Inbound Port" },
      "inbound.path": { label: "Inbound Path" },
    },
  },
  config: {
    listAccountIds: (cfg) => listHttpWebhookAccountIds(cfg as OpenClawConfig),
    resolveAccount: (cfg, accountId) =>
      resolveHttpWebhookAccount({ cfg: cfg as OpenClawConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultHttpWebhookAccountId(cfg as OpenClawConfig),
    setAccountEnabled: ({ cfg, enabled }) => {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "http-webhook": {
            ...(cfg.channels?.["http-webhook"] ?? {}),
            enabled,
          },
        },
      } as OpenClawConfig;
    },
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      if (next.channels) {
        const channels = { ...next.channels };
        delete channels["http-webhook"];
        next.channels = channels;
      }
      return next as OpenClawConfig;
    },
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveHttpWebhookAccount({
        cfg: cfg as OpenClawConfig,
        accountId,
      }).config.dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const allowFromPath = "channels.http-webhook.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("http-webhook"),
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- HTTP webhook DMs are open to anyone. Set channels.http-webhook.dm.policy="pairing" or "allowlist".`,
        );
      }
      if (!account.config.inbound?.token) {
        warnings.push(
          `- HTTP webhook inbound.token is not configured. Webhook endpoint will reject all requests.`,
        );
      }
      if (!account.config.outbound?.token || !account.config.outbound?.url) {
        warnings.push(
          `- HTTP webhook outbound credentials incomplete. Set channels.http-webhook.outbound.url and channels.http-webhook.outbound.token.`,
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim() || null,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return value.length > 0;
      },
      hint: "<user-id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveHttpWebhookAccount({
        cfg: cfg as OpenClawConfig,
        accountId,
      });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.dm?.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*"),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async () => [],
  },
  resolver: {
    resolveTargets: async ({ inputs }) => {
      const resolved = inputs.map((input) => {
        const normalized = input.trim();
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        return { input, resolved: true, id: normalized };
      });
      return resolved;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, name }) => {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "http-webhook": {
            ...(cfg.channels?.["http-webhook"] ?? {}),
            name,
          },
        },
      } as OpenClawConfig;
    },
    validateInput: ({ input }) => {
      if (!input.inboundToken) {
        return "HTTP webhook requires --inbound-token (bearer token for incoming requests).";
      }
      if (!input.outboundUrl) {
        return "HTTP webhook requires --outbound-url (remote webhook URL).";
      }
      if (!input.outboundToken) {
        return "HTTP webhook requires --outbound-token (bearer token for outgoing requests).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const inboundPort = input.inboundPort ? Number.parseInt(input.inboundPort, 10) : 5000;
      const inboundPath = input.inboundPath?.trim() || "/";
      const timeoutSeconds = input.timeoutSeconds
        ? Number.parseInt(input.timeoutSeconds, 10)
        : 30;

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "http-webhook": {
            ...(cfg.channels?.["http-webhook"] ?? {}),
            enabled: true,
            name: input.name,
            inbound: {
              port: inboundPort,
              path: inboundPath,
              token: input.inboundToken,
            },
            outbound: {
              url: input.outboundUrl,
              token: input.outboundToken,
              timeoutSeconds,
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getHttpWebhookRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw.filter((entry) => entry !== "*");

      if (trimmed) {
        return { ok: true, to: trimmed };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }

      return {
        ok: false,
        error: missingTargetError(
          "HTTP Webhook",
          "<user-id> or channels.http-webhook.dm.allowFrom[0]",
        ),
      };
    },
    sendText: async (ctx) => {
      const { cfg, to, text, accountId } = ctx;
      // Accept session from context if available (for reply flows)
      const session = (ctx as { session?: Record<string, unknown> }).session;

      const account = resolveHttpWebhookAccount({
        cfg: cfg as OpenClawConfig,
        accountId,
      });
      const result = await sendHttpWebhookMessage({
        account,
        message: {
          text,
          to,
          timestamp: Date.now(),
          // Only include session if it was provided and is non-empty
          ...(session && Object.keys(session).length > 0 ? { session } : {}),
        },
      });
      return {
        channel: "http-webhook",
        messageId: result.messageId ?? "",
        chatId: to,
      };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, accountId } = ctx;
      // Accept session from context if available (for reply flows)
      const session = (ctx as { session?: Record<string, unknown> }).session;

      if (!mediaUrl) {
        throw new Error("HTTP webhook mediaUrl is required.");
      }
      const account = resolveHttpWebhookAccount({
        cfg: cfg as OpenClawConfig,
        accountId,
      });

      // Convert media to base64
      let base64Data: string;
      let mediaType: string;
      let filename: string;

      const isRemoteUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");

      if (isRemoteUrl) {
        // Remote URL - fetch and convert to base64
        const response = await fetch(mediaUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        base64Data = Buffer.from(arrayBuffer).toString("base64");
        mediaType = response.headers.get("content-type") || getMimeTypeFromExtension(mediaUrl);
        filename = mediaUrl.split("/").pop()?.split("?")[0] || "file";
      } else {
        // Local file - read and convert to base64
        const fileBuffer = await readFile(mediaUrl);
        base64Data = fileBuffer.toString("base64");
        mediaType = getMimeTypeFromExtension(mediaUrl);
        filename = mediaUrl.split("/").pop() || "file";
      }

      const result = await sendHttpWebhookMessage({
        account,
        message: {
          text: text ?? "",
          to,
          files: [{ data: base64Data, mediaType, filename }],
          timestamp: Date.now(),
          // Only include session if it was provided and is non-empty
          ...(session && Object.keys(session).length > 0 ? { session } : {}),
        },
      });
      return {
        channel: "http-webhook",
        messageId: result.messageId ?? "",
        chatId: to,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) return [];
        const issues = [];
        if (!entry.inboundToken) {
          issues.push({
            channel: "http-webhook",
            accountId,
            kind: "config",
            message: "HTTP webhook inbound.token is missing.",
            fix: "Set channels.http-webhook.inbound.token.",
          });
        }
        if (!entry.outboundUrl) {
          issues.push({
            channel: "http-webhook",
            accountId,
            kind: "config",
            message: "HTTP webhook outbound.url is missing.",
            fix: "Set channels.http-webhook.outbound.url.",
          });
        }
        if (!entry.outboundToken) {
          issues.push({
            channel: "http-webhook",
            accountId,
            kind: "config",
            message: "HTTP webhook outbound.token is missing.",
            fix: "Set channels.http-webhook.outbound.token.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      inboundPort: snapshot.inboundPort ?? null,
      inboundPath: snapshot.inboundPath ?? null,
      inboundToken: snapshot.inboundToken ? "***" : null,
      outboundUrl: snapshot.outboundUrl ?? null,
      outboundToken: snapshot.outboundToken ? "***" : null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeHttpWebhook(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      inboundPort: account.config.inbound?.port,
      inboundPath: account.config.inbound?.path,
      inboundToken: account.config.inbound?.token ? "***" : undefined,
      outboundUrl: account.config.outbound?.url,
      outboundToken: account.config.outbound?.token ? "***" : undefined,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting HTTP webhook monitor`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        inboundPort: account.config.inbound?.port,
        inboundPath: account.config.inbound?.path,
        outboundUrl: account.config.outbound?.url,
      });
      const unregister = await startHttpWebhookMonitor({
        account,
        config: ctx.cfg as OpenClawConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
