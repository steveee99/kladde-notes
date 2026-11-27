import type { PluginIconProps } from '@kladde/plugin-api/client';

/** Material Symbol `book` (Rounded, weight 300) – any SVG in currentColor works */
export function LogbookIcon({ size = 24, className }: PluginIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M270-100q-45.83 0-77.92-32.08Q160-164.17 160-210v-540q0-45.83 32.08-77.92Q224.17-860 270-860h470q12.75 0 21.38 8.63Q770-842.75 770-830v540q0 12.75-8.62 21.37Q752.75-260 740-260H270q-20.4 0-35.2 14.07Q220-231.85 220-210.14q0 20.91 14.8 35.53Q249.6-160 270-160h490q12.75 0 21.38 8.63Q790-142.75 790-130q0 12.75-8.62 21.37Q772.75-100 760-100H270Zm90-220h350v-480H360v480Zm-60 0v-480h-30q-20.4 0-35.2 14.8Q220-770.4 220-750v436.15q9-3 18.73-4.57Q248.46-320 270-320h30Z" />
    </svg>
  );
}
