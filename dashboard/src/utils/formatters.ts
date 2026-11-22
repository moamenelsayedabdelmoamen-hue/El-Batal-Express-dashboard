export function formatDateTime(input?: string | number | Date | null): string {
  if (!input) return '—';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return typeof input === 'string' ? input : '—';
  }
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleString('ar-EG');
  }
}

export function formatCurrency(amount?: number | null): string {
  const num = Number(amount ?? 0);
  if (!Number.isFinite(num)) return '0 ج.م';
  return `${num.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
}
