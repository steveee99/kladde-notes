/** Copies text; resolves to whether it worked. `navigator.clipboard` is missing on plain HTTP, there a hidden field and `execCommand` do it */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (permission, focus): try the old way
  }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  // Inside an open dialog: its focus trap would take the focus back from a field outside
  (focused?.closest('[role="dialog"]') ?? document.body).appendChild(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    focused?.focus?.({ preventScroll: true });
  }
}
