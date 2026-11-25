import { getCollection, type CollectionEntry } from "astro:content";

export type Doc = CollectionEntry<"docs">;

export const docHref = (doc: Doc) => (doc.id === "index" ? "/" : `/${doc.id}/`);

/** Sidebar groups in order, and the same pages flat for previous and next. */
export async function getNav() {
  const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
  const groups = new Map<string, Doc[]>([["", []]]);
  for (const doc of docs) {
    const section = doc.data.section ?? "";
    groups.set(section, [...(groups.get(section) ?? []), doc]);
  }
  const sections = [...groups].filter(([, pages]) => pages.length > 0).map(([label, pages]) => ({ label, pages }));
  return { sections, pages: sections.flatMap((section) => section.pages) };
}
