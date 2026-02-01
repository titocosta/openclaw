import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type { HttpWebhookAccountConfig, HttpWebhookConfig } from "./types.config.js";

export type HttpWebhookCredentialSource = "config" | "none";

export type ResolvedHttpWebhookAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: HttpWebhookAccountConfig;
  credentialSource: HttpWebhookCredentialSource;
};

export function listHttpWebhookAccountIds(_cfg: OpenClawConfig): string[] {
  // Simplified: single account only
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultHttpWebhookAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

function resolveCredentialSource(config: HttpWebhookAccountConfig): HttpWebhookCredentialSource {
  const hasInboundToken = Boolean(config.inbound?.token);
  const hasOutboundToken = Boolean(config.outbound?.token);
  const hasOutboundUrl = Boolean(config.outbound?.url);

  if (hasInboundToken && hasOutboundToken && hasOutboundUrl) {
    return "config";
  }

  return "none";
}

export function resolveHttpWebhookAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedHttpWebhookAccount {
  const accountId = normalizeAccountId(params.accountId);
  const config = (params.cfg.channels?.["http-webhook"] ?? {}) as HttpWebhookConfig;
  const enabled = config.enabled !== false;
  const credentialSource = resolveCredentialSource(config);

  return {
    accountId,
    name: config.name?.trim() || undefined,
    enabled,
    config,
    credentialSource,
  };
}

export function listEnabledHttpWebhookAccounts(cfg: OpenClawConfig): ResolvedHttpWebhookAccount[] {
  return listHttpWebhookAccountIds(cfg)
    .map((accountId) => resolveHttpWebhookAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
