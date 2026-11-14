import { Facet } from '@codemirror/state';

/** A note an embed (`![[…]]`) can show */
export interface EmbedNote {
  id: string;
  title: string;
  content: string;
  /** Tasks inside the embed may be ticked (the reader may edit the source note) */
  canWrite: boolean;
  /** App path the header link goes to instead of the note (public links: the embedded note's own public link) */
  href?: string;
}

/** Resolves an embed target; null = not available to this reader */
export type EmbedResolver = (target: string) => EmbedNote | null;

/** Overrides `editorHost.resolveEmbed` (public links resolve only from what the server sent) */
export const embedResolverFacet = Facet.define<EmbedResolver, EmbedResolver | null>({ combine: (v) => v[0] ?? null });

/** Where an editor sits inside embeds: the notes above it (cycles) and, for a nested editor, its source */
export interface EmbedContext {
  depth: number;
  chain: string[];
  source: { noteId: string; startLine: number; canWrite: boolean } | null;
}

export const embedContext = Facet.define<EmbedContext, EmbedContext>({ combine: (v) => v[0] ?? { depth: 0, chain: [], source: null } });
