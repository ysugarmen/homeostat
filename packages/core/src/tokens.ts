import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";

let encoder: Tiktoken | undefined;

// Selection counts the same rule texts again and again (every MCP `context` call, every budget
// check); byte-pair encoding is the slow part, so counts are remembered per text. Bounded, and
// cleared whole when full: a long-lived MCP server must not grow without limit.
const counted = new Map<string, number>();
const MAX_COUNTED = 5000;

/**
 * Approximate token count of `text`. Claude's tokenizer is not available offline, so this uses
 * cl100k_base; it is close enough for injection budgets and is the value cached in `tokens`.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const known = counted.get(text);
  if (known !== undefined) return known;
  encoder ??= new Tiktoken(cl100k);
  const n = encoder.encode(text).length;
  if (counted.size >= MAX_COUNTED) counted.clear();
  counted.set(text, n);
  return n;
}
