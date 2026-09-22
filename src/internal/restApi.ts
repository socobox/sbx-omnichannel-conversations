import { getConfig } from "../config.js";
import type { JSONValue } from "../types.js";

// Thin REST wrapper around the SBX Omnichannel API — every call here already exists in the real
// backend today (nothing new was invented on the wire format). Auth is the SAME per-session token
// already passed to `new Client(token)` (see WsTransport#currentToken) — never the tenant's own
// api_key, which is a broad, server-side-only secret that must never reach a browser bundle. The
// backend narrows what that token can do per-request (see zavu's apiKeyOrChatSessionAuth).

export interface RestReaction {
  author: string;
  value: string;
  updated_at: string;
}

// Matches zavu's own `AttachmentPublicRow` (src/db/schema.ts) — a top-level sibling of `metadata`,
// same pattern as `reactions` below. No Rails equivalent (ChatMessage there has no multi-file
// concept, only singular `media`/`media_type`) — a genuinely new capability (2026-09-22).
export interface RestAttachment {
  key: string;
  name: string | null;
  content_type: string | null;
}

// Matches zavu's own `ChatMessagePublicRow` exactly (see sbx-omnichannel-zavu's
// `toChatMessagePublic`, src/db/repos/chat.repo.ts) — `reactions` is a top-level sibling of
// `metadata`, NOT nested inside it. The serializer also duplicates the raw, stored metadata one
// level deeper under `metadata.custom_metadata` (a straight port of Rails' own
// `ChatMessageSerializer#metadata`) — see Message.ts's constructor for why THAT nested copy, not
// the top level, is what `message.attributes` is actually built from.
export interface RestChatMessage {
  id: number;
  sid: string | null;
  body: string | null;
  media: string | null;
  media_type: string | null;
  metadata: Record<string, unknown>;
  reactions: RestReaction[];
  // Present (possibly empty) on every message since 2026-09-22; older cached data may lack it
  // entirely, so every read site treats it as optional. Empty on a single/legacy-attachment
  // message too — `media`/`media_type` still carry that one, see Message.ts's own comment.
  attachments?: RestAttachment[];
  response_time: number | null;
  chat_id: number;
  participant_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RestParticipant {
  id: number;
  agent_id: number | null;
  indentify: string | null;
  name: string | null;
  sid: string | null;
  conversation_sid: string | null;
  chat_id: number | null;
  participant_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Embedded only for a HUMAN_AGENT participant (see chat.repo.ts#toParticipantPublic on the
  // backend) — `name` above already mirrors `agent.name` server-side as of 2026-09-21, so this
  // is a defense-in-depth fallback for Participant#name, not the primary source.
  agent?: { id: number; name: string | null } | null;
}

export interface RestChat {
  id: number;
  name: string | null;
  conversation_sid: string | null;
  status: string;
  duration: number | null;
  metadata: Record<string, unknown>;
  source: string;
  client: string | null;
  omnichannel_tag: string[];
  created_at: string;
  updated_at: string;
  chat_messages?: RestChatMessage[];
  participants?: RestParticipant[];
  // Persisted, backend-computed unread count for the agent this session's own token identifies
  // (see zavu's chat.repo.ts#loadUnreadCounts) — null when nothing to compute against (a 'chat'-
  // scope/customer token, or an agent with no participant record in this chat).
  unread_count?: number | null;
}

const paths = {
  // `chatId` puede ser un string arbitrario: getConversationBySid lo pasa tal cual, y ese
  // endpoint resuelve por id numérico, conversation_sid O custom_id (ver Client#getConversationBySid).
  // Un custom_id con "/", "?" o "#" produciría una URL distinta de la pedida sin encodear.
  chat: (chatId: number | string) => `/chats/${encodeURIComponent(String(chatId))}`,
  webChatMessage: (chatId: number, messageId: number) => `/web_chats/${chatId}/messages/${messageId}`,
  webChatMessageMediaUrl: (chatId: number, messageId: number) => `/web_chats/${chatId}/messages/${messageId}/media_url`,
  webChatMessages: (chatId: number) => `/web_chats/${chatId}/messages`,
  webChatParticipant: (chatId: number, participantId: number) => `/web_chats/${chatId}/participants/${participantId}`,
} as const;

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const { apiBaseUrl } = getConfig();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sbx-omnichannel-conversations: ${init.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Same as `request`, but for a multipart body — no Content-Type header of our own, so
// fetch/undici sets the correct `multipart/form-data; boundary=...` for us.
async function requestForm<T>(token: string, path: string, form: FormData): Promise<T> {
  const { apiBaseUrl } = getConfig();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sbx-omnichannel-conversations: POST ${path} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

export function getChat(token: string, chatId: number | string): Promise<RestChat> {
  return request<RestChat>(token, paths.chat(chatId));
}

// `body` is a genuinely new capability (see this package's README) — persisted body edits only
// work for `client === 'web'` chats; the backend rejects (422) anything else, which surfaces here
// as a rejected Promise.
export function updateMessage(
  token: string,
  chatId: number,
  messageId: number,
  fields: { metadata?: JSONValue; body?: string },
): Promise<{ success: true }> {
  return request(token, paths.webChatMessage(chatId, messageId), {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

// `key` (added 2026-09-22): resolves ONE specific attachment on a multi-file message instead of
// the legacy singular `media` column — omitted, defaults to `media`, unchanged for every existing
// (single-attachment) caller.
export function getMessageMediaUrl(token: string, chatId: number, messageId: number, key?: string): Promise<{ url: string | null }> {
  const path = paths.webChatMessageMediaUrl(chatId, messageId);
  return request(token, key ? `${path}?key=${encodeURIComponent(key)}` : path);
}

// Backs Conversation#setAllMessagesRead/setAllMessagesUnread — persists "the last message this
// agent has read in this chat" server-side (see this package's README: this used to be an
// in-memory-only stub, lost on every page reload). `last_read_message_id: null` marks the whole
// chat unread again.
export function updateParticipant(
  token: string,
  chatId: number,
  participantId: number,
  fields: { last_read_message_id: number | null },
): Promise<{ success: true } | { success: false; errors?: Record<string, string[]> }> {
  return request(token, paths.webChatParticipant(chatId, participantId), {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

export interface SendMediaFile {
  file: Blob;
  filename?: string;
  contentType?: string | null;
}

// Genuinely new capability (see this package's README) — proxies an agent's outbound attachment(s)
// to zavu's own SBX upload endpoint and creates the message in one round trip. Works for every
// channel as of 2026-09-21 (a `client === 'web'`-only restriction existed before that). Multiple
// files (added 2026-09-22): plain multipart form-data already supports a repeated field name, so
// more than one item just appends "file" more than once — matches zavu's own
// `form.getAll("file")` on the other end exactly.
export function sendMedia(
  token: string,
  chatId: number,
  participantId: number,
  files: SendMediaFile[],
  body: string | undefined,
  attributes?: JSONValue,
): Promise<RestChatMessage> {
  const form = new FormData();
  for (const { file, filename, contentType } of files) {
    // The caller's explicit contentType is authoritative (matches real Twilio's own contract),
    // not just whatever the Blob's own .type happens to be — a FormData part's Content-Type can
    // only be set by constructing a fresh Blob with the desired type.
    const filePart = contentType && contentType !== file.type ? new Blob([file], { type: contentType }) : file;
    form.append("file", filePart, filename ?? "attachment");
  }
  form.append("participant_id", String(participantId));
  if (body) form.append("body", body);
  // Custom metadata at CREATE time (added 2026-09-22, closes a real gap: this was silently
  // dropped before — see Conversation#sendMessage's own comment). JSON-encoded: multipart has no
  // native nested-object field type.
  if (attributes !== undefined) form.append("attributes", JSON.stringify(attributes));
  return requestForm<RestChatMessage>(token, paths.webChatMessages(chatId), form);
}

export const RestApi = { getChat, updateMessage, getMessageMediaUrl, sendMedia, updateParticipant };
