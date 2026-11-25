import { apiKeyClient } from "@better-auth/api-key/client";
import type { ApiType } from "@imagine/server/src/api.ts";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient as createBetterAuthClient } from "better-auth/react";
import { hc } from "hono/client";

export type { InferRequestType, InferResponseType } from "hono/client";

// Routes sit under /api because the server's app is mounted there, so a call looks like client.api.tokens.$post(...).
export function createApiClient(baseUrl = "/", init?: RequestInit) {
  return hc<ApiType>(baseUrl, { init: { credentials: "include", ...init } });
}

// better-auth's React client for /api/auth: sign-in codes through the email-OTP plugin, sign-in and session hooks, users
// through the admin plugin, and personal access tokens through the api-key plugin. Leave baseURL unset to use the page's origin.
export function createAuthClient(baseURL?: string) {
  return createBetterAuthClient({
    baseURL,
    basePath: "/api/auth",
    plugins: [emailOTPClient(), adminClient(), apiKeyClient()],
  });
}
