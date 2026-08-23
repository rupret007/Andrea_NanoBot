import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compare two strings without leaking length or content through short-circuit
 * equality. Values are hashed first so timingSafeEqual always sees equal-length
 * buffers.
 */
export function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}
