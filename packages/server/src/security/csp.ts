import crypto from 'crypto';

/** sha256 sources for every inline `<script>` of the app's index.html (the theme script runs before first paint) */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * Content-Security-Policy of the web app. Scripts only from the app itself (plus the hashed inline theme
 * script), so a script that slips into a note through Markdown, a diagram or a drawing cannot run.
 * Images and PDFs may come from anywhere: notes embed images from other sites, links show site icons.
 */
export function appCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    // wasm: Excalidraw subsets fonts with WebAssembly when exporting
    `script-src 'self' 'wasm-unsafe-eval'${scriptHashes.length ? ` ${scriptHashes.join(' ')}` : ''}`,
    // CodeMirror, Mermaid and Excalidraw set inline styles
    "style-src 'self' 'unsafe-inline'",
    'img-src * data: blob:',
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' blob: data:",
    "frame-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
