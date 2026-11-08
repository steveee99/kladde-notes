/**
 * Diagrams in fenced code blocks: ```mermaid is passed to Mermaid as is, ```mindmap is a plain
 * Markdown outline that becomes a Mermaid mindmap. The first line that is not a list item is the
 * center; without one, a single top-level item is the center (several get a generic one).
 *
 * ```mindmap
 * Projekt X
 * - Ziele
 *   - Umsatz
 * - Team
 * ```
 */

export interface MindmapNode {
  text: string;
  children: MindmapNode[];
}

const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Plain text of a node: links and emphasis become their visible text */
export function mindmapText(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?!\w)/g, '$1$2')
    .trim();
}

/** Parses the outline; headings (# … ######) nest like list levels, indented lists nest below them */
export function parseMindmap(src: string): MindmapNode {
  const root: MindmapNode = { text: '', children: [] };
  /** Open ancestors with their depth: headings use their level, list items 10 + indentation */
  const stack: { depth: number; node: MindmapNode }[] = [{ depth: -1, node: root }];
  let headingDepth = 0;
  let explicitRoot = false;

  for (const line of src.replace(/\t/g, '  ').split('\n')) {
    if (!line.trim()) continue;
    let depth: number;
    let text: string;
    const heading = HEADING.exec(line);
    const item = LIST.exec(line);
    if (heading) {
      depth = heading[1].length;
      headingDepth = depth;
      text = heading[2];
    } else if (item) {
      depth = 10 + headingDepth + item[1].length;
      text = item[2];
    } else if (!explicitRoot && !root.text && root.children.length === 0) {
      root.text = mindmapText(line);
      explicitRoot = true;
      continue;
    } else {
      // Plain text below a node continues its line
      const last = stack[stack.length - 1].node;
      if (last !== root) last.text += ` ${mindmapText(line)}`;
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const node: MindmapNode = { text: mindmapText(text), children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }

  if (!explicitRoot) {
    if (root.children.length === 1) return root.children[0];
    root.text = 'Mindmap';
  }
  return root;
}

/** Text inside a Mermaid ["…"] label: quotes and line breaks would end it */
const label = (text: string) => `"${(text || ' ').replace(/"/g, '#quot;').replace(/\s+/g, ' ')}"`;

/** Mermaid source for a ```mindmap block */
export function mindmapToMermaid(src: string): string {
  const root = parseMindmap(src);
  const out = ['mindmap', `  root((${label(root.text)}))`];
  let id = 0;
  const walk = (node: MindmapNode, indent: string) => {
    for (const child of node.children) {
      out.push(`${indent}n${++id}(${label(child.text)})`);
      walk(child, `${indent}  `);
    }
  };
  walk(root, '    ');
  return out.join('\n');
}
