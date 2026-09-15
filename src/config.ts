// Twilio's own SDK needs nothing beyond the per-session token passed to `new Client(token)` —
// it always talks to Twilio's own infrastructure. This package talks to YOUR OWN SBX Omnichannel
// backend instead, so it needs to know its host — that's the "host" half of "change the library
// and the host" (the library half is the import; this is the one small addition on top of it).
//
// Deliberately NOT an api_key (or any other credential) — that's the tenant's own broad,
// server-side-only secret; shipping it here would mean baking it into a browser bundle. Every
// REST call this package makes instead reuses the SAME per-session token already passed to
// `new Client(token)` (see internal/wsTransport.ts's own `token` getter), authenticated the same
// way as the WS connection itself.
export interface SbxConversationsConfig {
  /** Base URL of the SBX Omnichannel API (e.g. "https://omnichannel.example.com"). No trailing slash. */
  apiBaseUrl: string;
}

let currentConfig: SbxConversationsConfig | null = null;

export function configure(config: SbxConversationsConfig): void {
  currentConfig = { apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, "") };
}

export function getConfig(): SbxConversationsConfig {
  if (!currentConfig) {
    throw new Error(
      "sbx-omnichannel-conversations: configure({apiBaseUrl}) must be called once before creating a Client — see the README.",
    );
  }
  return currentConfig;
}

/** Derives a ws:// or wss:// URL for /ws/chat from the configured apiBaseUrl. Exported for tests. */
export function wsUrlFor(token: string): string {
  const { apiBaseUrl } = getConfig();
  const wsBase = apiBaseUrl.replace(/^http/, "ws");
  return `${wsBase}/ws/chat?token=${encodeURIComponent(token)}`;
}
