import type { ResolvedHttpWebhookAccount } from "./accounts.js";
import type { HttpWebhookOutboundMessage, HttpWebhookApiResponse } from "./types.js";

export async function sendHttpWebhookMessage(params: {
  account: ResolvedHttpWebhookAccount;
  message: HttpWebhookOutboundMessage;
}): Promise<HttpWebhookApiResponse> {
  const { account, message } = params;
  const outbound = account.config.outbound;

  if (!outbound?.url) {
    return { ok: false, error: "outbound.url not configured" };
  }

  if (!outbound.token) {
    return { ok: false, error: "outbound.token not configured" };
  }

  const timeoutMs = (outbound.timeoutSeconds ?? 30) * 1000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${outbound.token}`,
  };

  // Debug logging
  console.log('[http-webhook] Sending outbound request:', {
    url: outbound.url,
    hasToken: !!outbound.token,
    tokenLength: outbound.token?.length,
    headers: {
      ...headers,
      Authorization: headers.Authorization ? `Bearer ***${headers.Authorization.slice(-4)}` : undefined
    }
  });

  try {
    const response = await fetch(outbound.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    // Try to parse response body for messageId
    try {
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const body = (await response.json()) as { messageId?: string };
        return { ok: true, messageId: body.messageId };
      }
    } catch {
      // Response parsing failed, but request succeeded
    }

    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return { ok: false, error: "request timeout" };
      }
      return { ok: false, error: err.message };
    }
    return { ok: false, error: String(err) };
  }
}

export async function probeHttpWebhook(
  account: ResolvedHttpWebhookAccount,
): Promise<{ ok: boolean; error?: string }> {
  const outbound = account.config.outbound;

  if (!outbound?.url) {
    return { ok: false, error: "outbound.url not configured" };
  }

  if (!outbound.token) {
    return { ok: false, error: "outbound.token not configured" };
  }

  // Just validate that the URL is reachable, don't send actual message
  try {
    const url = new URL(outbound.url);
    // Basic validation - URL is properly formatted
    if (!url.protocol.startsWith("http")) {
      return { ok: false, error: "outbound.url must use http or https" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `invalid outbound.url: ${String(err)}` };
  }
}
