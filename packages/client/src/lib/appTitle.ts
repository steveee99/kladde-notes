/**
 * The app's name: "Kladde", or what the server's APP_TITLE wrote into the page (`<meta name="application-name">`)
 */
export function appTitle(): string {
  if (typeof document === 'undefined') return 'Kladde';
  const value = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content.trim();
  return value || 'Kladde';
}
