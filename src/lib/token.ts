/** Official MuseNews token contract (EVM). */
export const TOKEN_CA = "0x21bed5462749227f1b83f654daeb6e44d5ea1cd6";

/** Buy $MuseNews on pons launchpad. */
export const TOKEN_BUY_URL =
  "https://www.ponsfamily.com/launchpad/0x21BEd5462749227F1b83f654DaeB6E44D5ea1Cd6";

export function shortCa(ca: string = TOKEN_CA) {
  if (ca.length < 12) return ca;
  return `${ca.slice(0, 6)}…${ca.slice(-4)}`;
}
