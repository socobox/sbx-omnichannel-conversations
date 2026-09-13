// Twilio's own SDK needs nothing beyond the per-session token passed to `new Client(token)` —
// it always talks to Twilio's own infrastructure. This package talks to YOUR OWN SBX Omnichannel
// backend instead, so it needs to know its host — that's the "host" half of "change the library
// and the host" (the library half is the import; this is the one small addition on top of it).
//
// A module-level singleton, set ONCE at app bootstrap, is what lets `new Client(token)` keep
// working with zero other call-site changes anywhere else in the app.
export interface SbxConversationsConfig {
  /** Base URL of the SBX Omnichannel API (e.g. "https://omnichannel.example.com"). No trailing slash. */
  apiBaseUrl: string;
  /**
   * The SAME tenant api_key the app's own REST client already sends as `Authorization: Bearer`
   * for every other omnichannel call — this package reuses it for its own REST reads
   * (message history, participants), completely separate from the per-agent WS token passed to
   * `new Client(token)`.
   */
  apiKey: string;
}

let currentConfig: SbxConversationsConfig | null = null;

export function configure(config: SbxConversationsConfig): void {
  currentConfig = { apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ""), apiKey: config.apiKey };
}

export function getConfig(): SbxConversationsConfig {
  if (!currentConfig) {
    throw new Error(
      "sbx-omnichannel-conversations: configure({apiBaseUrl, apiKey}) must be called once before creating a Client — see the README.",
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
