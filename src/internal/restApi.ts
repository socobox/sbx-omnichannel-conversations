import { getConfig } from "../config.js";

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

export function getChat(chatId: number | string): Promise<RestChat> {
  return request<RestChat>(`/chats/${chatId}`);
}

export function updateMessageMetadata(chatId: number, messageId: number, metadata: Record<string, unknown>): Promise<{ success: true }> {
  return request(`/web_chats/${chatId}/messages/${messageId}`, {
    method: "PUT",
    body: JSON.stringify({ metadata }),
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

export const RestApi = { getChat, updateMessageMetadata, addReaction, getMessageMediaUrl };
