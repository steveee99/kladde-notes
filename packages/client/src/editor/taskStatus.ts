import type { BlockContext, LeafBlock, MarkdownConfig } from '@lezer/markdown';
import { statusOfMarker, type TaskStatus } from '@kladde/shared';

/**
 * GFM only knows [ ] and [x]. Kladde tasks also have [O] (in progress) and [H] (blocked), so this
 * block parser runs before the GFM one and builds the same Task / TaskMarker nodes for all four.
 */
class StatusTaskParser {
  nextLine() {
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [cx.elt('TaskMarker', leaf.start, leaf.start + 3), ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3)])
    );
    return true;
  }
}

export const statusTaskList: MarkdownConfig = {
  parseBlock: [
    {
      name: 'StatusTaskList',
      leaf(cx, leaf) {
        return /^\[[oOhH]\][ \t]/.test(leaf.content) && cx.parentType().name === 'ListItem' ? new StatusTaskParser() : null;
      },
      before: 'TaskList',
    },
  ],
};

/** Status of a TaskMarker text like "[O]" */
export function markerStatus(marker: string): TaskStatus {
  return statusOfMarker(marker.charAt(1));
}
