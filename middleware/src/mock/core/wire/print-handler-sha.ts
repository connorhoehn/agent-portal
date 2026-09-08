// Prints the handler digest for the sources on disk, for the validator.
// A file rather than an inline `tsx -e` because relative imports do not
// resolve from `[eval]`, and the whole point is that there is exactly one
// implementation of this digest — the validator must not grow its own.
import { handlerSha } from './handler-sha.js';
process.stdout.write(handlerSha(new URL('../../../', import.meta.url).pathname));
