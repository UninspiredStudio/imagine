import { afterEach, expect, test } from "bun:test";
import { createMailer } from "./mail.ts";

const mail = {
  to: "ada@example.test",
  subject: "Your Imagine sign-in code",
  text: "Your Imagine sign-in code: 123456, valid 10 minutes.",
};
// Nothing listens on this port, so an SMTP attempt fails at once and never leaves the machine.
const CLOSED_SMTP = "smtp://127.0.0.1:9";

const realLog = console.log;
afterEach(() => {
  console.log = realLog;
});

// Records each request and answers 200, so no network is used.
function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("Plunk is used when its key is set, even if SMTP is configured too", async () => {
  const { calls, fetchFn } = fakeFetch();
  const send = createMailer(
    { plunkApiKey: "plunk-key", plunkApiUrl: "https://plunk.test/", smtpUrl: CLOSED_SMTP, mailFrom: "no-reply@example.test" },
    fetchFn,
  );
  // If SMTP were chosen, this would reject on the closed port.
  await send({ ...mail, html: "<p>123456</p>" });

  expect(calls.map((call) => call.url)).toEqual(["https://plunk.test/v1/send"]);
  expect(calls[0].init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer plunk-key" });
  expect(JSON.parse(calls[0].init.body as string)).toEqual({
    to: mail.to,
    subject: mail.subject,
    body: "<p>123456</p>",
    from: "no-reply@example.test",
  });
});

test("a Plunk error status fails the send", async () => {
  const { fetchFn } = fakeFetch(401);
  const send = createMailer({ plunkApiKey: "bad-key", plunkApiUrl: "https://plunk.test" }, fetchFn);
  await expect(send(mail)).rejects.toThrow("Plunk send failed with 401");
});

test("SMTP is used when SMTP_URL is set and no Plunk key is", async () => {
  const { calls, fetchFn } = fakeFetch();
  const send = createMailer({ plunkApiUrl: "https://plunk.test", smtpUrl: CLOSED_SMTP, mailFrom: "no-reply@example.test" }, fetchFn);
  await expect(send(mail)).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("with neither Plunk nor SMTP, the code goes to the console and nothing is sent", async () => {
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  const { calls, fetchFn } = fakeFetch();
  await createMailer({ plunkApiUrl: "https://plunk.test" }, fetchFn)(mail);

  expect(calls).toEqual([]);
  expect(logged.join("\n")).toContain("123456");
});

test("the sign-in mail carries the code in both its HTML and plain-text parts", async () => {
  const { signInCodeMail } = await import("./emails.tsx");
  const rendered = await signInCodeMail("123456", 10);
  expect(rendered.html).toContain("123456");
  expect(rendered.html).toContain("rgb(91,79,224)"); // the app's brand-primary
  expect(rendered.text).toContain("123456");
});
