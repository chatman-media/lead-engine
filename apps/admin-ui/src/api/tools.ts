import { getToken } from "./saas.ts";

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface ToolConfig {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
}

export interface BookingConfig {
  enabled: boolean;
  url: string | null;
}

export const tools = {
  listTools: (): Promise<{ tools: ToolConfig[] }> => request("/api/admin/tools"),

  getBookingConfig: (): Promise<BookingConfig> => request("/api/admin/tools/booking"),

  saveBookingUrl: (url: string): Promise<{ ok: boolean; url: string }> =>
    request("/api/admin/tools/booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),

  deleteBookingUrl: (): Promise<{ ok: boolean }> =>
    request("/api/admin/tools/booking", { method: "DELETE" }),
};
