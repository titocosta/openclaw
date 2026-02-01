import { z } from "zod";

// Inbound configuration (HTTP server receiving webhooks)
export const HttpWebhookInboundSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional().default(5000),
    path: z.string().optional().default("/"),
    token: z.string().optional(),
  })
  .strict();

// Outbound configuration (HTTP client sending webhooks)
export const HttpWebhookOutboundSchema = z
  .object({
    url: z.string().url().optional(),
    token: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional().default(30),
  })
  .strict();

// DM policy configuration
export const HttpWebhookDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["open", "pairing", "allowlist"]).optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.policy === "open" && !value.allowFrom?.includes("*")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowFrom"],
        message:
          'channels.http-webhook.dm.policy="open" requires channels.http-webhook.dm.allowFrom to include "*"',
      });
    }
  });

// Account-level configuration
export const HttpWebhookAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    inbound: HttpWebhookInboundSchema.optional(),
    outbound: HttpWebhookOutboundSchema.optional(),
    dm: HttpWebhookDmSchema.optional(),
    mediaMaxMb: z.number().positive().optional().default(20),
    textChunkLimit: z.number().int().positive().optional().default(4000),
  })
  .strict();

// Top-level channel configuration (single account only for now)
export const HttpWebhookConfigSchema = HttpWebhookAccountSchema;

// TypeScript types derived from schemas
export type HttpWebhookInboundConfig = z.infer<typeof HttpWebhookInboundSchema>;
export type HttpWebhookOutboundConfig = z.infer<typeof HttpWebhookOutboundSchema>;
export type HttpWebhookDmConfig = z.infer<typeof HttpWebhookDmSchema>;
export type HttpWebhookAccountConfig = z.infer<typeof HttpWebhookAccountSchema>;
export type HttpWebhookConfig = z.infer<typeof HttpWebhookConfigSchema>;
