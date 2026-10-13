/**
 * Trivial pure function used by the node-app fixture. Deterministic and
 * network-free so the whole harness (unit + e2e) stays reproducible.
 */
export function add(a: number, b: number): number {
  return a + b;
}
