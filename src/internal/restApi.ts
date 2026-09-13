import { getConfig } from "../config.js";
import type { JSONValue } from "../types.js";

// Thin REST wrapper around the SBX Omnichannel API — every call here already exists in the real
// backend today (nothing new was invented on the wire format). Auth is the tenant's own api_key
// (see config.ts's own comment on why that's a SEPARATE credential from the per-agent WS token).

export interface RestReaction {
  author: string;
  value: string;
  updated_at: string;
}

// Matches zavu's own `ChatMessagePublicRow` exactly (see sbx-omnichannel-zavu's
// `toChatMessagePublic`, src/db/repos/chat.repo.ts) — `reactions` is a top-level sibling of
// `metadata`, NOT nested inside it (the serializer duplicates raw metadata under
// `metadata.custom_metadata` for a Rails-compat reason unrelated to this package).
export interface RestChatMessage {
  id: number;
  sid: string | null;
  body: string | null;
  media: string | null;
  media_type: string | null;
  metadata: Record<string, unknown>;
  reactions: RestReaction[];
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
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBaseUrl, apiKey } = getConfig();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const { apiBaseUrl, apiKey } = getConfig();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sbx-omnichannel-conversations: POST ${path} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

export function getChat(chatId: number | string): Promise<RestChat> {
  return request<RestChat>(`/chats/${chatId}`);
}

// `body` is a genuinely new capability (see this package's README) — persisted body edits only
// work for `client === 'web'` chats; the backend rejects (422) anything else, which surfaces here
// as a rejected Promise.
export function updateMessage(chatId: number, messageId: number, fields: { metadata?: JSONValue; body?: string }): Promise<{ success: true }> {
  return request(`/web_chats/${chatId}/messages/${messageId}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

export function addReaction(chatId: number, messageId: number, participantId: number, value: string | null): Promise<{ success: true }> {
  return request(`/web_chats/${chatId}/messages/${messageId}/add_reaction`, {
    method: "POST",
    body: JSON.stringify({ participant_id: participantId, value }),
  });
}

export function getMessageMediaUrl(chatId: number, messageId: number): Promise<{ url: string | null }> {
  return request(`/web_chats/${chatId}/messages/${messageId}/media_url`);
}

// Genuinely new capability (see this package's README) — proxies an agent's outbound attachment
// to zavu's own SBX upload endpoint and creates the message in one round trip. Only works for
// `client === 'web'` chats; the backend rejects (422) anything else.
export function sendMedia(
  chatId: number,
  participantId: number,
  file: Blob,
  filename: string | undefined,
  body: string | undefined,
): Promise<RestChatMessage> {
  const form = new FormData();
  form.append("file", file, filename ?? "attachment");
  form.append("participant_id", String(participantId));
  if (body) form.append("body", body);
  return requestForm<RestChatMessage>(`/web_chats/${chatId}/messages`, form);
}

export const RestApi = { getChat, updateMessage, addReaction, getMessageMediaUrl, sendMedia };
