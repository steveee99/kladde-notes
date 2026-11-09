/** @type {import('tailwindcss').Config} */
// Every color is a CSS variable (see src/index.css), so the themes (light, dark, OLED) only swap variables
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"], [data-theme="oled"], [data-theme="material"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        raised: v('raised'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        faint: v('faint'),
        accent: v('accent'),
        'on-accent': v('on-accent'),
        'accent-container': v('accent-container'),
        'on-accent-container': v('on-accent-container'),
        accent2: v('accent2'),
        ok: v('ok'),
        warn: v('warn'),
        danger: v('danger'),
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { xl: 'var(--radius)', '2xl': 'calc(var(--radius) * 1.5)' },
      boxShadow: { soft: 'var(--shadow)' },
      transitionTimingFunction: { spring: 'cubic-bezier(.2,.9,.25,1.15)' },
    },
  },
  plugins: [],
};
