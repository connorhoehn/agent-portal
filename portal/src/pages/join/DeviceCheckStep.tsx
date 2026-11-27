// The device check (docs/interviews-tenant-plan.md row I2.3): camera and microphone with the library's pre-join
// device form (AudioVideoSettingsForm in its `prejoin` layout, bound to realtime-modules' device hooks), the
// same controls a call's settings use. Nothing is sent anywhere and nothing is kept: the preview stays on this
// device and stops when the step closes; "Test mic" plays a few seconds back from memory. The choice of device
// is remembered in this browser only, under the key a call reads. Declining recording does not skip this step.
import { useState } from 'react';
import { Button, Inline, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { WrappedAudioVideoSettingsForm } from '@connorhoehn/ui-components/integrations/realtime-modules';
import { CallNounProvider } from '@connorhoehn/ui-components/video';
import { useAudioVideoSettings, useMediaDevices } from '@connorhoehn/realtime-modules/client/video';
import { deviceCheckWords } from './deviceCheckWords.ts';

export function DeviceCheckStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [on, setOn] = useState(false);
  const devices = useMediaDevices();
  const settings = useAudioVideoSettings({ preview: on });
  // A blocked or missing microphone is said plainly, and Continue says what happens (deviceCheckWords.ts).
  const words = deviceCheckWords(devices.permission);
  const blocked = words.blocked !== null;

  const start = async () => {
    await devices.requestPermission(['audio', 'video']).catch(() => undefined);
    setOn(true);
  };

  return (
    <Stack gap="md" data-testid="join-devices">
      <T size="sm" as="p">
        Check that your camera and microphone work. What you see and hear here stays on this device: nothing is sent or kept.
      </T>
      {on ? (
        <CallNounProvider noun="call">
          <WrappedAudioVideoSettingsForm devices={devices} settings={settings} cameraOn layout="prejoin" data-testid="join-devices-form" />
        </CallNounProvider>
      ) : (
        <Inline gap="sm" align="center">
          <Button variant="secondary" onClick={() => { void start(); }} data-testid="join-devices-start">Turn on camera and microphone</Button>
          <T size="xs" tone="secondary">Your browser will ask whether this page may use them.</T>
        </Inline>
      )}
      {words.blocked && <InlineAlert tone="warning" data-testid="join-devices-blocked">{words.blocked}</InlineAlert>}
      {words.missing && <InlineAlert tone="info" data-testid="join-devices-missing">{words.missing}</InlineAlert>}
      {settings.previewError && on && !blocked && (
        <InlineAlert tone="warning" data-testid="join-devices-error">{settings.previewError}</InlineAlert>
      )}
      <Inline gap="sm" align="center">
        <Button variant="primary" onClick={onContinue} data-testid="join-devices-continue">{words.continueLabel}</Button>
        <Button variant="ghost" onClick={onBack} data-testid="join-devices-back">Back to my answers</Button>
      </Inline>
    </Stack>
  );
}
