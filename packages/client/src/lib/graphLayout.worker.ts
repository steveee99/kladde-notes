/// <reference lib="webworker" />
import { runLayout, type LayoutDone, type LayoutInput, type LayoutProgress } from './graphLayout';

// The layout of a large graph off the page's thread (see graphLayout.ts)
self.onmessage = (e: MessageEvent<LayoutInput>) => {
  const positions = runLayout(e.data, (done) => self.postMessage({ type: 'progress', done } satisfies LayoutProgress));
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'done', positions } satisfies LayoutDone, [positions.buffer]);
};
