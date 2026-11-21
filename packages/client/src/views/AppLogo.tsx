/**
 * The Kladde mark: a notebook (a "Kladde") with a darker spine, an elastic band and a label, drawn in the accent.
 * Band and label use --on-acc, so the mark follows the user's accent and both color schemes. The app icon in
 * `public/icons/icon.svg` is the same drawing on a dark tile.
 */
export function AppLogo({ size = 24 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0 text-acc">
      <rect x="4.5" y="2.5" width="15" height="19" rx="2.5" fill="currentColor" />
      <path d="M8 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h1z" fill="rgb(var(--on-acc))" fillOpacity=".28" />
      <rect x="15.4" y="2.5" width="1.7" height="19" fill="rgb(var(--on-acc))" fillOpacity=".55" />
      <rect x="9.6" y="7" width="4.4" height="1.6" rx=".8" fill="rgb(var(--on-acc))" fillOpacity=".8" />
      <rect x="9.6" y="10.2" width="2.8" height="1.6" rx=".8" fill="rgb(var(--on-acc))" fillOpacity=".8" />
    </svg>
  );
}
