/** @type {import('tailwindcss').Config} */
// Every color is a Material 3 color role defined as a CSS variable in src/index.css
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
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
      colors: Object.fromEntries(roles.map((r) => [r, v(r)])),
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        'display-l': type(57, 64, -0.25, '400'),
        'display-m': type(45, 52, 0, '400'),
        'display-s': type(36, 44, 0, '400'),
        'headline-l': type(32, 40, 0, '400'),
        'headline-m': type(28, 36, 0, '400'),
        'headline-s': type(24, 32, 0, '400'),
        'title-l': type(22, 28, 0, '400'),
        'title-m': type(16, 24, 0.15, '500'),
        'title-s': type(14, 20, 0.1, '500'),
        'body-l': type(16, 24, 0.5, '400'),
        'body-m': type(14, 20, 0.25, '400'),
        'body-s': type(12, 16, 0.4, '400'),
        'label-l': type(14, 20, 0.1, '500'),
        'label-m': type(12, 16, 0.5, '500'),
        'label-s': type(11, 16, 0.5, '500'),
      },
      // Tailwind radius names mapped onto the M3 shape scale (rounded = extra-small 4px)
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
