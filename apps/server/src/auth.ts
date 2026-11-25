import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, emailOTP } from "better-auth/plugins";
import { and, eq, isNull } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { SendMail } from "./mail.ts";
import * as schema from "./db/schema.ts";
import { pendingInviteForEmail } from "./invites.ts";
import type { Access, Authenticate, Principal } from "./registry.ts";
import type { TokenCodec } from "./token.ts";

export type Auth = ReturnType<typeof createAuth>;

export type AuthOptions = {
  db: BunSQLDatabase;
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  sendMail: SendMail;
  // Where better-auth's deferred work goes. Sending a code runs there, so a reply takes the same time whether or not a code is sent.
  runInBackground?: (task: Promise<unknown>) => void;
};

const CODE_TTL_SECONDS = 600;
const LAST_ADMIN = { code: "LAST_ADMIN", message: "The last admin can't be removed, demoted or banned" };
const SIGN_UP_NOT_INVITED = { code: "INVITE_REQUIRED", message: "Sign-up is by invite only" };

export function createAuth(options: AuthOptions) {
  const { db, sendMail } = options;
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // Codes are sent in the background, so a reply does not reveal whether one went out.
    advanced: { backgroundTasks: { handler: options.runInBackground ?? (() => {}) } },
    // better-auth's own per-address limits on /api/auth. A limited request gets 429 with X-Retry-After (see api.ts).
    rateLimit: {
      enabled: true,
      // Above the code's own 3-attempt limit, so a fourth wrong code gets TOO_MANY_ATTEMPTS rather than a bare 429.
      customRules: { "/sign-in/email-otp": { window: 60, max: 10 } },
    },
    hooks: {
      // Auth calls run one at a time (see api.ts), so two admins cannot demote each other at the same moment.
      before: createAuthMiddleware(async (ctx) => {
        if (!losesAdmin(ctx.path, ctx.body)) return;
        const admins = (await db.select().from(schema.user)).filter((u) => isActive(u) && isAdminRole(u.role));
        if (admins.length === 1 && admins[0].id === String(ctx.body?.userId)) throw APIError.from("BAD_REQUEST", LAST_ADMIN);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The real gate for new accounts, run for every user created. The first user on an empty registry is the admin.
          // Anyone else needs a pending invite, and gets that invite's role.
          before: async (user) => {
            if (!(await anyUser(db))) return { data: { ...user, role: "admin" } };
            const invite = await pendingInviteForEmail(db, user.email);
            if (!invite) throw APIError.from("FORBIDDEN", SIGN_UP_NOT_INVITED);
            return { data: { ...user, role: invite.role } };
          },
          // Runs after the user row is written. If this fails, the user exists and signs in normally, so the stale invite is harmless.
          after: async (user) => {
            await db
              .update(schema.invites)
              .set({ acceptedAt: new Date() })
              .where(and(eq(schema.invites.email, user.email), isNull(schema.invites.acceptedAt)));
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: CODE_TTL_SECONDS,
        // Wrong guesses allowed per code. The next attempt after these gets TOO_MANY_ATTEMPTS.
        allowedAttempts: 3,
        sendVerificationOTP: async ({ email, otp, type }) => {
          // Only sign-in codes are sent. The plugin's other types would need mail this app never sends.
          if (type !== "sign-in" || !(await mayReceiveSignInCode(db, email))) return;
          await sendMail({
            to: email,
            subject: "Your Imagine sign-in code",
            text: `Your Imagine sign-in code: ${otp}, valid ${CODE_TTL_SECONDS / 60} minutes.\n\nIf you did not ask for this code, ignore this email.`,
          });
        },
      }),
      admin(),
      apiKey({
        // Personal access tokens. The plugin's default of 10 requests a day would reject a single push.
        rateLimit: { enabled: false },
        permissions: { defaultPermissions: { registry: ["read", "write"] } },
      }),
    ],
  });
}

// better-auth's admin plugin stores roles as a comma-separated string.
export function isAdminRole(role: unknown): boolean {
  return [role].flat().join(",").split(",").includes("admin");
}

// Whether an admin-plugin call would leave its target without a working admin account.
function losesAdmin(path: string, body: { role?: unknown; data?: Record<string, unknown> } | undefined): boolean {
  switch (path) {
    case "/admin/remove-user":
    case "/admin/ban-user":
      return true;
    case "/admin/set-role":
      return !isAdminRole(body?.role);
    case "/admin/update-user":
      // Changing a ban's expiry can make an expired ban permanent.
      return (
        Boolean(body?.data?.banned) ||
        body?.data?.banExpires !== undefined ||
        (body?.data?.role !== undefined && !isAdminRole(body.data.role))
      );
    default:
      return false;
  }
}

export async function anyUser(db: BunSQLDatabase): Promise<boolean> {
  const [row] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  return row !== undefined;
}

// A code goes out only to an account that may sign in, to an invitee, or to whoever sets up an empty registry.
// Everyone else gets the same reply without a mail, so the reply does not reveal who has an account.
async function mayReceiveSignInCode(db: BunSQLDatabase, email: string): Promise<boolean> {
  const [existing] = await db
    .select({ banned: schema.user.banned, banExpires: schema.user.banExpires })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (existing) return isActive(existing);
  if (!(await anyUser(db))) return true;
  return (await pendingInviteForEmail(db, email)) !== undefined;
}

// Same rule as the admin plugin's ban: a banned user stays locked out until the ban's expiry, and forever if it has none.
export function isActive(user: { banned?: boolean | null; banExpires?: Date | string | null }): boolean {
  if (!user.banned) return true;
  return user.banExpires != null && new Date(user.banExpires).getTime() <= Date.now();
}

// Turns a request's credentials into a Principal. Basic auth's username is ignored: the password is the personal access
// token, so a client cannot claim to be another user. Every credential is checked against its owner, so a banned or
// removed user loses access even while a token they were issued is still unexpired.
export function createAuthenticate(options: { auth: Auth; db: BunSQLDatabase; tokens: TokenCodec }): Authenticate {
  const { auth, db, tokens } = options;

  const activeOwner = async (userId: string) => {
    const [row] = await db
      .select({ id: schema.user.id, banned: schema.user.banned, banExpires: schema.user.banExpires })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    return row !== undefined && isActive(row) ? row : undefined;
  };

  const fromPersonalAccessToken = async (credential: string): Promise<Principal> => {
    const key = basicPassword(credential);
    if (key === undefined) return { kind: "invalid" };
    const check = await auth.api.verifyApiKey({ body: { key } });
    if (!check.valid || !check.key || !(await activeOwner(check.key.referenceId))) return { kind: "invalid" };
    const registry = check.key.permissions?.registry ?? [];
    const actions: Access[] = [];
    if (registry.includes("read")) actions.push("pull");
    if (registry.includes("write")) actions.push("push");
    return { kind: "user", userId: check.key.referenceId, actions };
  };

  const fromRegistryToken = async (credential: string): Promise<Principal> => {
    const claims = tokens.read(credential);
    if (!claims) return { kind: "invalid" };
    if (claims.sub !== null && !(await activeOwner(claims.sub))) return { kind: "invalid" };
    return { kind: "token", grants: claims.access };
  };

  return async (req) => {
    const header = req.headers.get("authorization");
    if (header === null) {
      // A signed-in browser may pull but never push, so the web UI can browse without being able to write.
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) return { kind: "none" };
      return isActive(session.user)
        ? { kind: "user", userId: session.user.id, actions: ["pull"] }
        : { kind: "invalid" };
    }
    const [scheme = "", credential = ""] = header.split(" ");
    switch (scheme.toLowerCase()) {
      case "basic":
        return fromPersonalAccessToken(credential);
      case "bearer":
        return fromRegistryToken(credential);
      default:
        return { kind: "invalid" };
    }
  };
}

function basicPassword(credential: string): string | undefined {
  const decoded = Buffer.from(credential, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? undefined : decoded.slice(colon + 1);
}
