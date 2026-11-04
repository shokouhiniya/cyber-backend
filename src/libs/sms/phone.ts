/**
 * Iranian mobile numbers in one canonical form: `09xxxxxxxxx` (11 digits).
 *
 * Accepts Persian (۰-۹) and Arabic-Indic (٠-٩) digits, spaces, dashes,
 * parentheses and the +98 / 0098 / 98 country prefixes, or a bare
 * `9xxxxxxxxx`. Returns null when the input is not a mobile number.
 */
export function toLatinDigits(input: string): string {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function normalizeIranPhone(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let s = toLatinDigits(String(input)).trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0098')) s = s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = s.slice(2);
  if (s.startsWith('0')) s = s.slice(1);
  if (!/^9\d{9}$/.test(s)) return null;
  return `0${s}`;
}

/** `09121234567` → `0912***4567` for logs and audit rows. */
export function maskPhone(phone: string | null | undefined): string {
  const p = String(phone ?? '');
  if (p.length < 8) return '***';
  return `${p.slice(0, 4)}***${p.slice(-4)}`;
}
