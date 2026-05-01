export interface Admin {
  id: number;
  email: string;
}

export interface User {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: number;
  mode: "ai" | "queued" | "human";
  escalated_at: number | null;
  last_message_at: number | null;
  assigned_admin_id: number | null;
  user: {
    id: number;
    tg_user_id: number;
    tg_username: string | null;
  };
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  tg_message_id: number | null;
  created_at: number;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? res.statusText,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    req<{ admin: Admin }>("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    req<{ ok: boolean }>("/admin/api/logout", { method: "POST" }),

  me: () =>
    req<{ admin: Admin }>("/admin/api/me"),

  users: () =>
    req<{ users: User[] }>("/admin/api/users"),

  conversations: (escalated?: boolean) =>
    req<{ conversations: Conversation[] }>(
      `/admin/api/conversations${escalated ? "?escalated=1" : ""}`,
    ),

  conversation: (id: number) =>
    req<{
      conversation: Conversation;
      user: User;
      messages: Message[];
    }>(`/admin/api/conversations/${id}`),

  take: (id: number) =>
    req<{ conversation: Conversation }>(
      `/admin/api/conversations/${id}/take`,
      { method: "POST" },
    ),

  release: (id: number) =>
    req<{ conversation: Conversation }>(
      `/admin/api/conversations/${id}/release`,
      { method: "POST" },
    ),

  sendMessage: (id: number, text: string) =>
    req<{ ok: boolean }>(
      `/admin/api/conversations/${id}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    ),

  deleteConversation: (id: number) =>
    req<{ ok: boolean; deleted: number }>(
      `/admin/api/conversations/${id}`,
      { method: "DELETE" },
    ),
};

export { ApiError };
