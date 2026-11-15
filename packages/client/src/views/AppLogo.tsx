/**
 * The Kladde mark (document with a check) as a tonal M3 tile: primary-container behind the symbol in
 * on-primary-container, so it follows the colour scheme like the "New note" button. The cut-outs use
 * the tile colour, so the symbol needs no background of its own (unlike `public/icons/icon.svg`).
 */
export function AppLogo({ size = 48 }: { size?: number }) {
  const glyph = Math.round(size * 0.6);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-primary-container text-on-primary-container"
      style={{ width: size, height: size }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="112 114 284 308" width={glyph} height={glyph}>
        <path d="M150 128h168l64 64v192a24 24 0 0 1-24 24H150a24 24 0 0 1-24-24V152a24 24 0 0 1 24-24z" fill="currentColor" />
        <path d="M318 128v48a16 16 0 0 0 16 16h48" fill="rgb(var(--primary-container))" fillOpacity=".35" />
        <path d="M176 262l34 34 70-74" fill="none" stroke="rgb(var(--primary-container))" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M176 352h160" stroke="rgb(var(--primary-container))" strokeWidth="26" strokeLinecap="round" opacity=".7" />
      </svg>
    </span>
  );
}
