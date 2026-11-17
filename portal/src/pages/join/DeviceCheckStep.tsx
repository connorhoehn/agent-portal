// The device check (docs/interviews-tenant-plan.md row I2.3): camera and microphone with the library's pre-join
// device form (AudioVideoSettingsForm in its `prejoin` layout, bound to realtime-modules' device hooks), the
// same controls a call's settings use. Nothing is sent anywhere and nothing is kept: the preview stays on this
// device and stops when the step closes; "Test mic" plays a few seconds back from memory. The choice of device
// is remembered in this browser only, under the key a call reads. Declining recording does not skip this step.
import { useState } from 'react';
import { Button, Inline, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { WrappedAudioVideoSettingsForm } from '@connorhoehn/ui-components/integrations/realtime-modules';
import { useAudioVideoSettings, useMediaDevices } from '@connorhoehn/realtime-modules/client/video';

export function DeviceCheckStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [on, setOn] = useState(false);
  const devices = useMediaDevices();
  const settings = useAudioVideoSettings({ preview: on });
  const blocked = devices.permission.camera === 'denied' || devices.permission.microphone === 'denied';
  const missing = devices.permission.camera === 'unavailable' || devices.permission.microphone === 'unavailable';

  const start = async () => {
    await devices.requestPermission(['audio', 'video']).catch(() => undefined);
    setOn(true);
  };

  return (
    <Stack gap="md" className="max-w-3xl" data-testid="join-devices">
      <T size="sm" as="p">
        Check that your camera and microphone work. What you see and hear here stays on this device: nothing is sent or kept.
      </T>
      {on ? (
        <WrappedAudioVideoSettingsForm devices={devices} settings={settings} cameraOn layout="prejoin" data-testid="join-devices-form" />
      ) : (
        <Inline gap="sm" align="center">
          <Button variant="secondary" onClick={() => { void start(); }} data-testid="join-devices-start">Turn on camera and microphone</Button>
          <T size="xs" tone="secondary">Your browser will ask whether this page may use them.</T>
        </Inline>
      )}
      {blocked && (
        <InlineAlert tone="warning" data-testid="join-devices-blocked">
          Your browser is not letting this page use your camera or microphone. Allow them in the browser&apos;s site settings, then turn them on again.
        </InlineAlert>
      )}
      {missing && !blocked && (
        <InlineAlert tone="info" data-testid="join-devices-missing">
          No camera or microphone was found. Plug one in, then turn them on again.
        </InlineAlert>
      )}
      {settings.previewError && on && !blocked && (
        <InlineAlert tone="warning" data-testid="join-devices-error">{settings.previewError}</InlineAlert>
      )}
      <Inline gap="sm" align="center">
        <Button variant="primary" onClick={onContinue} data-testid="join-devices-continue">Continue</Button>
        <Button variant="ghost" onClick={onBack} data-testid="join-devices-back">Back to my answers</Button>
      </Inline>
    </Stack>
  );
}
