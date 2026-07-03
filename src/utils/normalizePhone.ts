export function normalizePhone(phone?: string | null): string {
  if (!phone) return '';

  let digits = phone.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!digits.startsWith('55')) {
    digits = `55${digits}`;
  }

  return digits;
}

/** Gera variantes com/sem o 9º dígito móvel brasileiro para consulta no WhatsApp. */
export function getBrazilianWhatsAppVariants(digits: string): string[] {
  const normalized = normalizePhone(digits);
  const candidates = [normalized];

  if (!normalized.startsWith('55')) return candidates;

  const afterCountry = normalized.slice(2);
  if (afterCountry.length < 10) return candidates;

  const ddd = afterCountry.slice(0, 2);
  const subscriber = afterCountry.slice(2);

  // Formato novo: DDD + 9 + 8 dígitos → tenta sem o 9
  if (subscriber.length === 9 && subscriber[0] === '9') {
    candidates.push(`55${ddd}${subscriber.slice(1)}`);
  }

  // Formato antigo: DDD + 8 dígitos móveis → tenta com o 9
  if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    candidates.push(`55${ddd}9${subscriber}`);
  }

  return [...new Set(candidates)];
}
