/** @type {import('tailwindcss').Config} */
// Every color is a CSS variable from src/index.css: the Werkbank tokens (docs/DESIGN.md) and the
// Material 3 role names that are kept as aliases onto them
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const werkbank = [
  'bg', 'panel', 'bar', 'raised', 'line', 'line2', 'sunken', 'strong', 'text', 'body', 'soft', 'muted', 'faint', 'edge',
  'acc', 'acc-hi', 'acc-bg', 'acc-line', 'on-acc',
  'amber', 'amber-hi', 'amber-bg', 'red', 'red-bg', 'violet', 'violet-bg', 'green', 'green-bg',
];
const roles = [
  'primary', 'on-primary', 'primary-container', 'on-primary-container',
  'secondary', 'on-secondary', 'secondary-container', 'on-secondary-container',
  'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container',
  'error', 'on-error', 'error-container', 'on-error-container',
  'surface', 'surface-dim', 'surface-bright',
  'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest',
  'on-surface', 'on-surface-variant', 'outline', 'outline-variant',
  'inverse-surface', 'inverse-on-surface', 'inverse-primary', 'scrim',
  'ok', 'on-ok', 'ok-container', 'on-ok-container', 'warn', 'on-warn', 'warn-container', 'on-warn-container',
];
/** Material 3 type scale: [size, { lineHeight, letterSpacing, fontWeight }] */
const type = (size, lineHeight, letterSpacing, fontWeight) => [`${size}px`, { lineHeight: `${lineHeight}px`, letterSpacing: `${letterSpacing}px`, fontWeight }];
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-scheme="dark"]'],
  theme: {
    extend: {
      /*
       * `nav:` switches between the mobile layout (top app bar, bottom navigation bar, modal drawer) and the
       * desktop layout (navigation rail or sidebar). With a mouse or trackpad that happens at 768px; touch
       * screens (tablets) keep the mobile layout in portrait and switch in landscape from 1024px on, so an
       * iPad in portrait gives the editor the full width.
       */
      screens: {
        nav: { raw: '(min-width: 768px) and (pointer: fine), (min-width: 1024px) and (orientation: landscape), (min-width: 1280px)' },
        /*
         * Tablet-sized screens (wide and tall enough): the bottom navigation bar offers extra destinations
         * there. Phones, also in landscape, keep the five main ones. Because `nav` is a raw query, Tailwind
         * generates no `max-*` variants; use `phone:` (below `sm`) instead.
         */
        tablet: { raw: '(min-width: 640px) and (min-height: 600px)' },
        phone: { raw: '(max-width: 639.98px)' },
      },
      colors: Object.fromEntries([...werkbank, ...roles].map((r) => [r, v(r)])),
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      // Werkbank type scale (docs/DESIGN.md): dense, Inter, no extra letter spacing
      fontSize: {
        'display-l': type(48, 56, -0.5, '600'),
        'display-m': type(40, 48, -0.4, '600'),
        'display-s': type(34, 40, -0.3, '600'),
        'headline-l': type(30, 36, -0.2, '600'),
        'headline-m': type(26, 32, -0.2, '600'),
        'headline-s': type(22, 28, -0.1, '600'),
        'title-xl': type(30, 36, -0.2, '600'),
        'title-l': type(20, 28, 0, '600'),
        'title-m': type(15, 22, 0, '600'),
        'title-s': type(13, 20, 0, '600'),
        'body-l': type(15, 24, 0, '400'),
        'body-m': type(13, 20, 0, '400'),
        'body-s': type(12, 18, 0, '400'),
        'label-l': type(13, 20, 0, '500'),
        'label-m': type(12, 16, 0, '500'),
        'label-s': type(11, 16, 0, '500'),
        caption: type(11, 16, 0.66, '500'),
      },
      // Tailwind radius names mapped onto the Werkbank shape scale (rounded = 4px pills, md 6px controls, lg 8px cards)
      borderRadius: {
        sm: 'var(--shape-sm)',
        md: 'var(--shape-sm)',
        lg: 'var(--shape-md)',
        xl: 'var(--shape-md)',
        '2xl': 'var(--shape-lg)',
        '3xl': 'var(--shape-xl)',
      },
      boxShadow: { soft: 'var(--elevation-1)', 'elevation-1': 'var(--elevation-1)', 'elevation-2': 'var(--elevation-2)', 'elevation-3': 'var(--elevation-3)' },
      transitionTimingFunction: { spring: 'var(--ease-spring)', standard: 'var(--ease-standard)', emphasized: 'var(--ease)' },
    },
  },
  plugins: [],
};
