import { RestApi } from "./internal/restApi.js";

// Mirrors @twilio/conversations' own `Media` class — one attached file on a Message.
// `getContentTemporaryUrl()` resolves lazily (a real network call, same as Twilio's own), never
// eagerly for every message in a chat.
export class Media {
  readonly contentType: string;
  readonly filename: string | null;

  private readonly chatId: number;
  private readonly messageId: number;
  private cachedUrl: string | null | undefined;

  /** @internal */
  constructor(opts: { chatId: number; messageId: number; contentType: string; filename?: string | null }) {
    this.chatId = opts.chatId;
    this.messageId = opts.messageId;
    this.contentType = opts.contentType;
    this.filename = opts.filename ?? null;
  }

  async getContentTemporaryUrl(): Promise<string | null> {
    if (this.cachedUrl !== undefined) return this.cachedUrl;
    const { url } = await RestApi.getMessageMediaUrl(this.chatId, this.messageId);
    this.cachedUrl = url;
    return url;
  }
}
