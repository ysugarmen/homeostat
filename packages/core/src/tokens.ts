import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";

let encoder: Tiktoken | undefined;

/**
 * Approximate token count of `text`. Claude's tokenizer is not available offline, so this uses
 * cl100k_base; it is close enough for injection budgets and is the value cached in `tokens`.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  encoder ??= new Tiktoken(cl100k);
  return encoder.encode(text).length;
}
