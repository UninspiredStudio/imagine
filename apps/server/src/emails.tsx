import { render } from "@react-email/render";
import type { ReactNode } from "react";
import { Body, Button, Container, Head, Heading, Html, Preview, Section, Tailwind, Text, pixelBasedPreset } from "react-email";
// The web app's Tailwind theme (Subframe tokens), so mail and app share colors, type scale and radii.
// @ts-expect-error: a plain CommonJS config without type declarations.
import appTheme from "../../../packages/components/ui/tailwind.config.js";

// Mail clients that don't load web fonts would fall back to a serif, so the app's font names get safe fallbacks here.
const SANS = ["Manrope", "Helvetica", "Arial", "sans-serif"];
const MONO = ['"DM Mono"', "Menlo", "Consolas", "monospace"];
const mailTheme = {
  presets: [pixelBasedPreset, appTheme],
  theme: { extend: { fontFamily: { body: SANS, "body-bold": SANS, "heading-2": SANS, caption: SANS, "monospace-heading": MONO } } },
};

function Layout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Tailwind config={mailTheme}>
        <Head>
          <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700&family=DM+Mono:wght@500&display=swap" rel="stylesheet" />
        </Head>
        <Preview>{preview}</Preview>
        <Body className="m-0 bg-page-background py-10 font-body">
          <Container className="mx-auto max-w-[480px] px-4">
            <Text className="m-0 mb-4 font-heading-2 text-heading-2 text-brand-primary">Imagine</Text>
            <Section className="rounded-lg border border-solid border-neutral-border bg-default-background px-8 py-6">{children}</Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

function SignInCode({ code, minutes }: { code: string; minutes: number }) {
  return (
    <Layout preview={`Your sign-in code: ${code}`}>
      <Heading as="h1" className="m-0 font-heading-2 text-heading-2 text-default-font">
        Your sign-in code
      </Heading>
      <Text className="font-body text-body text-secondary-font">Enter this code to sign in to Imagine. It is valid for {minutes} minutes.</Text>
      <Text className="my-6 rounded-md bg-neutral-100 py-4 text-center font-monospace-heading text-monospace-heading tracking-[0.3em] text-default-font">
        {code}
      </Text>
      <Text className="m-0 font-caption text-caption text-subtext-color">If you did not ask for this code, ignore this email.</Text>
    </Layout>
  );
}

function Invite({ role, url }: { role: string; url: string }) {
  return (
    <Layout preview={`You've been invited to Imagine as ${role}`}>
      <Heading as="h1" className="m-0 font-heading-2 text-heading-2 text-default-font">
        You're invited to Imagine
      </Heading>
      <Text className="font-body text-body text-secondary-font">You've been invited to Imagine as {role}. Accept the invite to create your account.</Text>
      <Button href={url} className="my-2 rounded-md bg-brand-primary px-4 py-2 font-body-bold text-body-bold text-white">
        Accept invite
      </Button>
      <Text className="font-body text-body text-secondary-font">Or open this link: {url}</Text>
      <Text className="m-0 font-caption text-caption text-subtext-color">The link works for 7 days.</Text>
    </Layout>
  );
}

// The plain-text part keeps its own wording: the console fallback logs it, and it stays a single readable line.
async function mail(subject: string, element: ReactNode, text: string) {
  return { subject, html: await render(element), text };
}

export const signInCodeMail = (code: string, minutes: number) =>
  mail(
    "Your Imagine sign-in code",
    <SignInCode code={code} minutes={minutes} />,
    `Your Imagine sign-in code: ${code}, valid ${minutes} minutes.\n\nIf you did not ask for this code, ignore this email.`,
  );

export const inviteMail = (role: string, url: string) =>
  mail("You're invited to Imagine", <Invite role={role} url={url} />, `You've been invited to Imagine as ${role}: ${url}\n\nThe link works for 7 days.`);
