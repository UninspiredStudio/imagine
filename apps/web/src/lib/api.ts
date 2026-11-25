import { createApiClient } from "@imagine/api-client";
import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth";

export const apiClient = createApiClient();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Every failed app route answers { error }.
export async function apiError(res: { status: number; json(): Promise<unknown> }): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new ApiError(res.status, typeof body?.error === "string" ? body.error : `Request failed (${res.status})`);
}

// better-auth's client returns { data, error } instead of throwing.
export function unwrap<T>(result: { data: T | null; error: { status: number; message?: string } | null }): T {
  if (result.error || result.data === null) {
    throw new ApiError(result.error?.status ?? 500, result.error?.message || "Something went wrong");
  }
  return result.data;
}

export const metaQueryOptions = queryOptions({
  queryKey: ["meta"],
  queryFn: async () => {
    const res = await apiClient.api.meta.$get();
    if (res.ok) return res.json();
    throw new Error(`GET /api/meta failed with ${res.status}`);
  },
});

export const repositoriesQueryOptions = queryOptions({
  queryKey: ["repositories"],
  queryFn: async () => {
    const res = await apiClient.api.repositories.$get();
    if (res.ok) return res.json();
    throw await apiError(res);
  },
});

export const tagsQueryOptions = (name: string) =>
  queryOptions({
    queryKey: ["tags", name],
    queryFn: async () => {
      const res = await apiClient.api.repositories.tags.$get({ query: { name } });
      if (res.ok) return res.json();
      throw await apiError(res);
    },
  });

export const invitesQueryOptions = queryOptions({
  queryKey: ["invites"],
  queryFn: async () => {
    const res = await apiClient.api.invites.$get();
    if (res.ok) return res.json();
    throw await apiError(res);
  },
});

export const usersQueryOptions = queryOptions({
  queryKey: ["users"],
  queryFn: async () => {
    const res = await apiClient.api.users.$get();
    if (res.ok) return res.json();
    throw await apiError(res);
  },
});

// A digest's platforms never change, so they are fetched once. Ask for at most 25 digests, the server's limit.
export const platformsQueryOptions = (name: string, digests: string[]) =>
  queryOptions({
    queryKey: ["platforms", name, digests],
    queryFn: async () => {
      const res = await apiClient.api.repositories.platforms.$get({ query: { name, digest: digests } });
      if (res.ok) return res.json();
      throw await apiError(res);
    },
    staleTime: Infinity,
    enabled: digests.length > 0,
  });

export const apiKeysQueryOptions = queryOptions({
  queryKey: ["api-keys"],
  queryFn: async () =>
    unwrap(await authClient.apiKey.list({ query: { sortBy: "createdAt", sortDirection: "desc" } })).apiKeys,
});

export type Role = "user" | "admin";

// better-auth's admin plugin stores roles as a comma-separated string.
export function isAdmin(user: { role?: string | null }): boolean {
  return user.role?.split(",").includes("admin") ?? false;
}

export async function sendInvite(invite: { email: string; role: Role }) {
  const res = await apiClient.api.invites.$post({ json: invite });
  if (res.ok) return res.json();
  throw await apiError(res);
}

// Resolves to null when the token is unknown, expired or used.
export async function lookupInvite(token: string) {
  const res = await apiClient.api.invites.lookup.$get({ query: { token } });
  if (res.ok) return res.json();
  if (res.status === 404) return null;
  throw new Error(`GET /api/invites/lookup failed with ${res.status}`);
}
