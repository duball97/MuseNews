/** Official MuseNews token contract (EVM). */
export const TOKEN_CA = "0x21bed5462749227f1b83f654daeb6e44d5ea1cd6";

export function shortCa(ca: string = TOKEN_CA) {
  if (ca.length < 12) return ca;
  return `${ca.slice(0, 6)}…${ca.slice(-4)}`;
}
