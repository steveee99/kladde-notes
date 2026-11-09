export type ThemeChoice = 'system' | 'light' | 'dark' | 'oled' | 'material';
const KEY = 'kladde_theme';

export function getTheme(): ThemeChoice {
  try {
    return (localStorage.getItem(KEY) as ThemeChoice) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = getTheme()): void {
  const resolved = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim().split(/\s+/).join(',');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `rgb(${bg})`);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // private mode: the choice lasts for this visit
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition) doc.startViewTransition(() => applyTheme(choice));
  else applyTheme(choice);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => getTheme() === 'system' && applyTheme());
