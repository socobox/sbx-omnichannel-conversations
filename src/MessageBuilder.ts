import type { Conversation } from "./Conversation.js";
import type { JSONValue, SendMediaOptions } from "./types.js";

// Mirrors @twilio/conversations' own MessageBuilder/UnsentMessage — but only the
// setBody/addMedia/setAttributes/build().send() subset the reference frontend actually calls
// (EmailChatInputComponent.tsx). Twilio's own builder also supports subjects, email
// body/history parts, and Content Template SIDs — none of those are exercised anywhere in the
// migrated frontend, so they're not implemented here (a call would just be a missing method,
// same as any other unaudited Twilio API surface this package doesn't cover).
export class MessageBuilder {
  private bodyText: string | undefined;
  private attrs: JSONValue | undefined;
  private mediaItems: SendMediaOptions[] = [];

  /** @internal */
  constructor(private readonly conversation: Conversation) {}

  setBody(text: string): MessageBuilder {
    this.bodyText = text;
    return this;
  }

  setAttributes(attributes: JSONValue): MessageBuilder {
    this.attrs = attributes;
    return this;
  }

  addMedia(payload: SendMediaOptions): MessageBuilder {
    this.mediaItems.push(payload);
    return this;
  }

  build(): { send: () => Promise<number | null> } {
    return {
      send: async () => {
        if (this.mediaItems.length > 1) {
          throw new Error(
            "sbx-omnichannel-conversations: sending more than one attachment in a single message isn't supported yet — send each as its own message.",
          );
        }
        if (this.mediaItems.length === 1) {
          return await this.conversation.sendMessage(this.mediaItems[0]!, this.attrs);
        }
        return await this.conversation.sendMessage(this.bodyText ?? "", this.attrs);
      },
    };
  }
}
