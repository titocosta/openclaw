import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setHttpWebhookRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getHttpWebhookRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("HTTP Webhook runtime not initialized");
  }
  return runtime;
}
