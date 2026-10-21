// Content hashing for version stamps (classifier rules, price table). Pure, so core
// stays free of Node APIs. FNV-1a 64-bit: not cryptographic, only a change detector.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Code-unit order, not locale order: the hash must not depend on the machine's locale. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** JSON with object keys sorted, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof RegExp) return { regex: v.source, flags: v.flags };
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareKeys(a, b)));
    }
    return v;
  });
}

export function contentHash(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
