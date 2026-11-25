import { expect, test } from "bun:test";
import { createTokenCodec, TOKEN_TTL_SECONDS } from "./token.ts";

const codec = createTokenCodec("token-test-secret-token-test-secret");
const grant = [{ name: "team/app", actions: ["pull" as const] }];

test("a registry token reads back with its owner and grants", () => {
  expect(codec.read(codec.issue("user-1", grant))).toEqual({ sub: "user-1", access: grant });
});

test("a token signed with another secret, or with its payload changed, is refused", () => {
  const jwt = codec.issue("user-1", grant);
  expect(createTokenCodec("another-secret-another-secret-0000").read(jwt)).toBeNull();

  const [header, , signature] = jwt.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "user-2", access: [], iat: 0, exp: 4102444800 })).toString("base64url");
  expect(codec.read(`${header}.${forged}.${signature}`)).toBeNull();
  expect(codec.read("not-a-token")).toBeNull();
});

test("an expired token is refused", () => {
  const issuedLongAgo = Math.floor(Date.now() / 1000) - TOKEN_TTL_SECONDS - 1;
  expect(codec.read(codec.issue("user-1", grant, issuedLongAgo))).toBeNull();
});
