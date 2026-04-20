/** Shared pure helpers for MemoryGraph and mutation orchestration. */

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','need','dare','ought',
  'to','of','in','for','on','with','at','by','from','as','into',
  'through','during','before','after','above','below','between',
  'and','but','or','nor','not','so','yet','both','either','neither',
  'it','its','this','that','these','those','i','me','my','we','our',
]);

export function tokenize(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w))
  )];
}

const SOURCE_WEIGHTS = {
  user_explicit: 1.0, system: 0.95, tool_output: 0.85,
  user_implicit: 0.7, document: 0.6, inference: 0.5,
};

export function computeTrust(provenance, reinforcements = 0, disputes = 0, ageDays = 0) {
  const sourceBase = SOURCE_WEIGHTS[provenance?.source] || 0.5;
  const corroborationBonus = Math.min(0.2, ((provenance?.corroboration || 1) - 1) * 0.05);
  const feedbackTotal = reinforcements + disputes;
  const feedbackSignal = feedbackTotal > 0 ? ((reinforcements - disputes) / feedbackTotal) * 0.15 : 0;
  const recencyPenalty = Math.max(0, Math.min(0.1, ageDays / 365 * 0.1));
  return Math.max(0, Math.min(1.0, sourceBase + corroborationBonus + feedbackSignal - recencyPenalty));
}

export function computeConfidence(mem) {
  return +(mem.provenance?.trust ?? 0.5).toFixed(4);
}

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function normalizeNone(value) {
  return value;
}

function normalizeTrim(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeLowercase(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function normalizeLowercaseTrim(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeCurrency(value) {
  if (typeof value !== 'string') return value;
  const original = value;
  const text = value.trim();
  if (!text) return original;

  const lower = text.toLowerCase();
  let currency = null;

  if (/\b(usd|us\$)\b/.test(lower) || /\$/.test(text) || /dollars?/.test(lower) || /bucks?/.test(lower)) currency = 'USD';
  else if (/\b(eur)\b/.test(lower) || /€/.test(text) || /euros?/.test(lower)) currency = 'EUR';
  else if (/\b(gbp)\b/.test(lower) || /£/.test(text) || /\bpounds?\b/.test(lower) || /\bsterling\b/.test(lower)) currency = 'GBP';
  else if (/\b(jpy)\b/.test(lower) || /¥/.test(text) || /\byen\b/.test(lower)) currency = 'JPY';
  else if (/\b(cad)\b/.test(lower) || /\bc\$\b/.test(lower)) currency = 'CAD';
  else if (/\b(aud)\b/.test(lower) || /\ba\$\b/.test(lower)) currency = 'AUD';
  else if (/\b(inr)\b/.test(lower) || /₹/.test(text) || /\brupees?\b/.test(lower)) currency = 'INR';

  const amountMatch = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!currency || !amountMatch) return original;
  const amount = Number.parseFloat(amountMatch[0].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return original;
  const amountText = Number.isInteger(amount) ? String(amount) : String(Number.parseFloat(amount.toFixed(12)));
  return `${currency} ${amountText}`;
}

const CLAIM_NORMALIZERS = Object.freeze({
  none: normalizeNone,
  trim: normalizeTrim,
  lowercase: normalizeLowercase,
  lowercase_trim: normalizeLowercaseTrim,
  currency: normalizeCurrency,
});

export function claimComparableValue(claim) {
  return claim?.normalizedValue ?? claim?.value;
}

export function normalizeClaim(claim, normalize = 'none') {
  if (!claim || typeof claim !== 'object') return claim;
  const normalizedClaim = { ...claim };
  const mode = normalize || 'none';
  const normalizer = CLAIM_NORMALIZERS[mode] || CLAIM_NORMALIZERS.none;
  normalizedClaim.normalizedValue = normalizer(claim.value);
  return normalizedClaim;
}
