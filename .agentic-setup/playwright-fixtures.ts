// Shared Playwright fixtures (stage 2). Playwright is passed in, since some repos install it only in
// one workspace. In a repo's e2e/test.ts (allowHosts: checks.config.ts e2e.allowHosts):
//   import { test as base, expect } from '@playwright/test'
//   export const test = base.extend<SharedFixtures>(sharedFixtureDefs(allowHosts)) // TypeScript
//   export const test = sharedFixtures(base, allowHosts)                           // JavaScript
//   export { expect }
// - every request to a host other than the test server's (or an allowed host) is aborted;
// - stillFor(ms) moves the page clock forward instead of waiting in real time.
type Route = { request(): { url(): string }; fallback(): Promise<void>; abort(): Promise<void> };
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
  clock: { install(): Promise<void>; runFor(ms: number): Promise<void> };
};
type Base<T> = { extend(fixtures: Record<string, unknown>): T };
export type SharedFixtures = { blockThirdParty: void; stillFor: (ms: number) => Promise<void> };

export function sharedFixtureDefs(allowHosts: string[] = []) {
  const blockThirdParty = async ({ page, baseURL }: { page: Page; baseURL?: string }, use: () => Promise<void>) => {
    const own = new URL(baseURL ?? "http://127.0.0.1").host;
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const host = url.startsWith("http") ? new URL(url).host : own;
      // fallback, not continue: a spec's own page.route or context.route for these hosts still runs.
      return host === own || allowHosts.includes(host) ? route.fallback() : route.abort();
    });
    await use();
  };
  return {
    blockThirdParty: [blockThirdParty, { auto: true }] as [typeof blockThirdParty, { auto: boolean }],
    stillFor: async ({ page }: { page: Page }, use: (fn: (ms: number) => Promise<void>) => Promise<void>) => {
      // Installed before the test runs, so requestAnimationFrame loops start on the fake clock.
      // A spec that uses stillFor doesn't install page.clock itself.
      await page.clock.install();
      await use(async (ms: number) => { await page.clock.runFor(ms); });
    },
  };
}

// Untyped fixtures: `base.extend` can't carry them through this signature, so TypeScript specs use
// sharedFixtureDefs above.
export function sharedFixtures<T>(base: Base<T>, allowHosts: string[] = []): T {
  return base.extend(sharedFixtureDefs(allowHosts));
}
