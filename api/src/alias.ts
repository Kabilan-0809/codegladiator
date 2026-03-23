const ADJECTIVES = [
  'Iron', 'Void', 'Shadow', 'Storm', 'Neon',
  'Hex', 'Binary', 'Quantum', 'Null', 'Byte',
  'Cipher', 'Rogue', 'Static', 'Ghost', 'Turbo',
  'Chrome', 'Dark', 'Hyper', 'Nano', 'Ultra',
] as const;

const NOUNS = [
  'Syntax', 'Coder', 'Cipher', 'Logic', 'Stack',
  'Loop', 'Array', 'Node', 'Kernel', 'Pixel',
  'Parser', 'Daemon', 'Signal', 'Vector', 'Matrix',
  'Proxy', 'Shell', 'Thread', 'Patch', 'Forge',
] as const;

/**
 * Deterministic alias generator from UUID seed.
 * Same UUID always produces the same alias.
 * Splits UUID and uses modulo to pick adjective + noun.
 */
export function generateAlias(uuid: string): string {
  // Remove dashes and split into two halves
  const clean = uuid.replace(/-/g, '');
  const firstHalf = clean.slice(0, 16);
  const secondHalf = clean.slice(16, 32);

  // Parse hex values and take modulo
  const adjIdx = parseInt(firstHalf.slice(0, 8), 16) % ADJECTIVES.length;
  const nounIdx = parseInt(secondHalf.slice(0, 8), 16) % NOUNS.length;

  return `${ADJECTIVES[adjIdx]}${NOUNS[nounIdx]}`;
}
