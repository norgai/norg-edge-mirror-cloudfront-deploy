/**
 * Constant-time string comparison for secrets (the health-probe site key).
 *
 * Both inputs are hashed to a fixed 32 bytes first, so neither the length nor
 * the position of the first differing byte can be observed through timing, then
 * the digests are compared with an accumulating XOR that never exits early.
 */

/**
 * @param {string} a Candidate value (e.g. a request header).
 * @param {string} b Expected secret.
 * @returns {Promise<boolean>} True only when both strings are identical.
 */
export async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
