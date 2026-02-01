import crypto from "crypto";

const FLY_API = "https://api.machines.dev/v1";

// Validate required environment variables
function validateFlyEnv() {
  const required = {
    FLY_API_TOKEN: process.env.FLY_API_TOKEN,
    FLY_APP_NAME: process.env.FLY_APP_NAME,
    FLY_REGION: process.env.FLY_REGION,
    FLY_IMAGE: process.env.FLY_IMAGE,
    NEXT_PUBLIC_WEB_LIVE_URL: process.env.NEXT_PUBLIC_WEB_LIVE_URL,
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required Fly.io environment variables: ${missing.join(', ')}`);
  }
}

async function flyRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  // Validate environment variables before making request
  validateFlyEnv();

  const apiToken = process.env.FLY_API_TOKEN;

  console.log(`[flyio] Making request to ${path}`);

  const headers: HeadersInit = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const res = await fetch(`${FLY_API}${path}`, {
    ...options,
    headers
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[flyio] Request failed: ${res.status} ${res.statusText} - ${errorText}`);
    throw new Error(`Fly.io API error (${res.status}): ${errorText}`);
  }

  return res.json();
}

export async function createVolume(userId: string) {
  console.debug(`[flyio] Creating volume for user ${userId}`);
  return flyRequest<{
    id: string;
    name: string;
  }>(`/apps/${process.env.FLY_APP_NAME}/volumes`, {
    method: "POST",
    body: JSON.stringify({
      name: `v_${userId}`.substring(0, 30).toLowerCase(),
      region: process.env.FLY_REGION,
      size_gb: 2
    })
  });
}


export async function createMachine(
  userId: string,
  volumeId: string,
  envVariables: Record<string, string> = {}
) {
  console.debug(`[flyio] Creating machine for user ${userId} with volume ${volumeId}`);
  const gatewayToken = crypto.randomBytes(32).toString("hex");

  const machine = await flyRequest<{
    id: string;
    name: string;
  }>(`/apps/${process.env.FLY_APP_NAME}/machines`, {
    method: "POST",
    body: JSON.stringify({
      name: `m_${userId}`.substring(0, 30).toLowerCase(),
      region: process.env.FLY_REGION,
      config: {
        image: process.env.FLY_IMAGE,
        guest: {
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 256
        },
        mounts: [
          {
            volume: volumeId,
            path: "/data"
          }
        ],
        env: {
          ...envVariables,
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          HTTP_WEBHOOK_INBOUND_TOKEN: gatewayToken,
          HTTP_WEBHOOK_OUTBOUND_TOKEN: gatewayToken,
          HTTP_WEBHOOK_OUTBOUND_URL: `${process.env.NEXT_PUBLIC_WEB_LIVE_URL}/api/openclaw/webhook/${userId}`,
          OPENCLAW_CONFIG_PATH: "/data/openclaw.json",
          ANTHROPIC_API_KEY: envVariables?.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
          GEMINI_API_KEY: envVariables?.geminiApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        services: [
          {
            protocol: "tcp",
            internal_port: 8080,
            ports: [{ port: 443, handlers: ["tls"] }]
          }
        ]
      }
    })
  });

  return {
    machineId: machine.id,
    machineName: machine.name,
    hostname: `${machine.name}.fly.dev`,
    gatewayToken
  };
}

export async function updateMachine(machineId: string, envVariables: Record<string, string>) {
  return flyRequest<{
    id: string;
    name: string;
  }>(`/apps/${process.env.FLY_APP_NAME}/machines/${machineId}`, {
    method: "PATCH",
    body: JSON.stringify({
      config: {
        env: envVariables
      }
    })
  });
}

export async function provisionUserOpenclaw(userId: string) {
  console.log(`[flyio] Provisioning OpenClaw for user ${userId}`);

  console.log(`[flyio] Creating volume for user ${userId}`);
  const volume = await createVolume(userId);
  console.log(`[flyio] Volume created: ${volume.id}`);

  console.log(`[flyio] Creating machine for user ${userId}`);
  const machine = await createMachine(userId, volume.id);
  console.log(`[flyio] Machine created: ${machine.machineId}, hostname: ${machine.hostname}`);

  return {
    userId,
    volumeId: volume.id,
    machineId: machine.machineId,
    hostname: machine.hostname,
    gatewayToken: machine.gatewayToken
  };
}

