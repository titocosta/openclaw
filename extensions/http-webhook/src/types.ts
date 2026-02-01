// AI SDK message types (Vercel AI SDK ModelMessage format)
export type TextPart = {
  type: "text";
  text: string;
};

export type ImagePart = {
  type: "image";
  image: string | Uint8Array | ArrayBuffer | URL;
  mediaType?: string;
};

export type FilePart = {
  type: "file";
  data: string | Uint8Array | ArrayBuffer | URL;
  mediaType: string;
};

export type UserMessageContent = string | Array<TextPart | ImagePart | FilePart>;

export type SystemModelMessage = {
  role: "system";
  content: string;
};

export type UserModelMessage = {
  role: "user";
  content: UserMessageContent;
};

export type AssistantModelMessage = {
  role: "assistant";
  content: string;
};

export type ToolModelMessage = {
  role: "tool";
  content: string;
};

export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage;

// Inbound message payload (received via POST to local HTTP server)
// Accepts either simple `text` field or AI SDK `messages` array
export type HttpWebhookInboundMessage = {
  from: string;
  fromName?: string;
  mediaUrl?: string;
  messageId?: string;
  timestamp?: number;
} & (
  | { text: string; messages?: never }
  | { text?: never; messages: ModelMessage[] }
);

// Usage tracking types
export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsageSnapshot = {
  provider: string;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

// Token usage types
export type TokenUsageByModel = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requestCount: number;
};

export type TokenUsageByProvider = {
  [model: string]: TokenUsageByModel;
};

export type TokenUsagePeriod = {
  providers: {
    [provider: string]: TokenUsageByProvider;
  };
  startedAt: number;
  lastUpdatedAt: number;
};

export type TokenUsageData = {
  allTime: TokenUsagePeriod;
  monthly: TokenUsagePeriod;
  weekly: TokenUsagePeriod;
  daily: TokenUsagePeriod;
};

// File attachment for outbound messages (base64 encoded only)
export type HttpWebhookFileAttachment = {
  data: string;        // Base64 encoded file content
  mediaType: string;   // MIME type (e.g., "image/png", "application/pdf")
  filename?: string;   // Optional filename
};

// Outbound message payload (sent via POST to remote webhook URL)
export type HttpWebhookOutboundMessage = {
  text: string;
  to: string;
  files?: HttpWebhookFileAttachment[];  // Array of base64 file attachments
  timestamp: number;
  usage?: UsageSummary;
  tokens?: TokenUsageData;
};

// API response from outbound webhook
export type HttpWebhookApiResponse = {
  ok: boolean;
  messageId?: string;
  error?: string;
};
