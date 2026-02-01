import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { httpWebhookPlugin } from "./src/channel.js";
import { setHttpWebhookRuntime } from "./src/runtime.js";

const plugin = {
  id: "http-webhook",
  name: "HTTP Webhook",
  description: "OpenClaw HTTP Webhook channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setHttpWebhookRuntime(api.runtime);
    api.registerChannel({ plugin: httpWebhookPlugin });
  },
};

export default plugin;
