import type { APIRoute } from "astro";
import { respond, toMarkdown } from "../markdown";
import { getNav } from "../nav";

// Every page in sidebar order, in one file.
export const GET: APIRoute = async () => {
  const { pages } = await getNav();
  return respond(pages.map(toMarkdown).join("\n---\n\n"), "plain");
};
