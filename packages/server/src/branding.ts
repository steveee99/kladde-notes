/*
 * APP_TITLE: the name the app shows instead of "Kladde" (browser tab, home screen, installed app, sign-in page, top
 * bar, passkey prompts). The server writes it into the served index.html and the web app manifest; the client reads
 * it from `<meta name="application-name">`. Kladde's own name stays in the about page and the code.
 */

export const DEFAULT_APP_TITLE = 'Kladde';
const TITLE_MAX = 40;

/** APP_TITLE trimmed, without control characters and at most 40 characters; null when unset (then "Kladde") */
export function appTitleFromEnv(env: NodeJS.ProcessEnv): string | null {
  // eslint-disable-next-line no-control-regex
  const raw = (env.APP_TITLE ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  return [...raw].slice(0, TITLE_MAX).join('').trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** index.html with the title in `<title>`, `application-name` and `apple-mobile-web-app-title` */
export function brandIndexHtml(html: string, title: string): string {
  const t = escapeHtml(title);
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  for (const name of ['application-name', 'apple-mobile-web-app-title']) {
    const tag = new RegExp(`<meta name="${name}" content="[^"]*"\\s*/?>`);
    out = tag.test(out) ? out.replace(tag, `<meta name="${name}" content="${t}" />`) : out.replace('</head>', `  <meta name="${name}" content="${t}" />\n  </head>`);
  }
  return out;
}

/** The web app manifest with `name` and `short_name` set to the title (unchanged when it is no JSON) */
export function brandManifest(json: string, title: string): string {
  try {
    const manifest = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify({ ...manifest, name: title, short_name: title });
  } catch {
    return json;
  }
}
