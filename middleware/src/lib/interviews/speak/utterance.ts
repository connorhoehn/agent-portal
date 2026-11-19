/** A spoken line as the fixed requests read it: lower case, no apostrophes, words split on anything else (the one normaliser). */
export const utterance = (text: string): string => text.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
