/** Large amounts in whole dollars, everyday amounts in cents, tiny per-call amounts to 4 places. */
function usdDigits(value: number): number {
  if (value >= 100) return 0;
  if (value >= 1) return 2;
  return 4;
}

export function usd(value: number): string {
  if (value === 0) {
    return '$0';
  }

  const digits = usdDigits(value);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function compact(value: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function percent(part: number, total: number): string {
  if (total === 0) return '–';
  const p = (part / total) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : p.toFixed(0)}%`;
}

export function share(value: number | null): string {
  return value === null ? '–' : percent(value, 1);
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
