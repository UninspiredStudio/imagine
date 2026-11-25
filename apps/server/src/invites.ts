import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { invites } from "./db/schema.ts";

export const newInviteToken = (): string => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// Pending means not accepted yet and not expired. Expiry is compared on the database clock, the same clock that sets expiresAt.
export const isPending = () => and(isNull(invites.acceptedAt), gt(invites.expiresAt, sql`now()`));

export async function pendingInviteForEmail(db: BunSQLDatabase, email: string) {
  const [invite] = await db
    .select({ email: invites.email, role: invites.role })
    .from(invites)
    .where(and(eq(invites.email, email), isPending()))
    .limit(1);
  return invite;
}

export async function pendingInviteForToken(db: BunSQLDatabase, token: string) {
  const [invite] = await db
    .select({ email: invites.email, role: invites.role })
    .from(invites)
    .where(and(eq(invites.tokenHash, hashInviteToken(token)), isPending()))
    .limit(1);
  return invite;
}
