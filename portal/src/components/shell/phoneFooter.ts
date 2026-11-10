// Below 40rem (Tailwind's `sm`) the shell footer is one row: the huddle bar and the voice dock take the library's
// compact forms (ui-components 2.519.0 HuddleBar `compact`, VoiceDock `density="compact"`).
import { useViewportWidth } from '@connorhoehn/ui-components/shared';

export const PHONE_FOOTER_MAX = 640;

export function usePhoneFooter(): boolean {
  return useViewportWidth() < PHONE_FOOTER_MAX;
}
