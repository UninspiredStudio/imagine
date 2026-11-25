import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Grant } from "./registry.ts";

// Docker reuses a token for about this long. A banned or removed owner is still refused on every request, since
// registry.ts checks the owner rather than trusting the token.
export const TOKEN_TTL_SECONDS = 300;

const claimsSchema = z.object({
  sub: z.string().nullable(),
  exp: z.number().int(),
  access: z.array(
    z.object({ type: z.literal("repository"), name: z.string(), actions: z.array(z.enum(["pull", "push"])) }),
  ),
});

export type TokenCodec = ReturnType<typeof createTokenCodec>;

// HS256 JWTs. The signing key is derived from the auth secret, so the cookie-signing key itself is not reused.
export function createTokenCodec(secret: string) {
  const key = createHmac("sha256", secret).update("imagine registry token").digest();
  const sign = (signingInput: string) => createHmac("sha256", key).update(signingInput).digest("base64url");

  return {
    // sub is the owner's user id, or null for an anonymous token.
    issue(sub: string | null, access: Grant[], issuedAt = Math.floor(Date.now() / 1000)): string {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub,
          access: access.map(({ name, actions }) => ({ type: "repository", name, actions })),
          iat: issuedAt,
          exp: issuedAt + TOKEN_TTL_SECONDS,
        }),
      ).toString("base64url");
      return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
    },

    // The header is not read: only HS256 with this key is ever produced or accepted, so there is no algorithm to confuse.
    read(jwt: string): { sub: string | null; access: Grant[] } | null {
      const parts = jwt.split(".");
      if (parts.length !== 3) return null;
      const [header, payload, signature] = parts;
      const expected = Buffer.from(sign(`${header}.${payload}`));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let json: unknown;
      try {
        json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      const claims = claimsSchema.safeParse(json);
      if (!claims.success || claims.data.exp * 1000 <= Date.now()) return null;
      return { sub: claims.data.sub, access: claims.data.access.map(({ name, actions }) => ({ name, actions })) };
    },
  };
}
