import { describe, expect, it } from 'vitest';
import { add } from './index.ts';

describe('add', () => {
  it('sums two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles negatives', () => {
    expect(add(-4, 1)).toBe(-3);
  });
});
