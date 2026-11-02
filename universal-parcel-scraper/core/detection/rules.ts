/**
 * Detection rule matching.
 *
 * What it is: whether a catalog detection rule's pattern fits a normalized
 * number and its rawPattern the printed one, with each rule's expressions
 * compiled once. Detection and recognition share it.
 * What it is not: no checksum and no carrier choice.
 */
import type { DetectionRule } from '../catalog/types.js';

interface CompiledRule { pattern: RegExp; rawPattern?: RegExp }

const compiled = new WeakMap<DetectionRule, CompiledRule>();

/** The rule's pattern fits the normalized number, and its rawPattern, if any, the printed input. */
export function ruleFits(rule: DetectionRule, normalized: string, printed: string): boolean {
  let expressions = compiled.get(rule);
  if (!expressions) {
    expressions = { pattern: new RegExp(rule.pattern), ...(rule.rawPattern ? { rawPattern: new RegExp(rule.rawPattern) } : {}) };
    compiled.set(rule, expressions);
  }
  return expressions.pattern.test(normalized) && (!expressions.rawPattern || expressions.rawPattern.test(printed));
}
