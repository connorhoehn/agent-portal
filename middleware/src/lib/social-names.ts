// The name rule a Social channel, team or room must meet. Shared by the routes and the `/agent`
// loop's `meeting:create` step so both ask exactly the same of a name.
import { ValidationError } from './async-handler.js';
import { isValidSlug, slugify } from './social-chat.js';

export const NAME_MAX = 80;

export function requiredName(raw: unknown, what: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > NAME_MAX) throw new ValidationError(`a ${what} needs a name of 1–${NAME_MAX} characters`);
  if (!isValidSlug(slugify(name))) throw new ValidationError(`a ${what} name needs at least one letter or digit`);
  return name;
}
