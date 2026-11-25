import type { APIRoute } from "astro";
import { respond, toMarkdown } from "../markdown";
import { getNav, type Doc } from "../nav";

export async function getStaticPaths() {
  const { pages } = await getNav();
  return pages.map((doc) => ({ params: { slug: doc.id }, props: { doc } }));
}

export const GET: APIRoute<{ doc: Doc }> = ({ props }) => respond(toMarkdown(props.doc), "markdown");
