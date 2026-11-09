// Settings › Voice (G38): the voice navigator's voice, speaking style and pace.
//
// Reads GET /api/voice/settings and saves each change at once through PUT.
// Hidden when the read answers 403 (no VoiceNavigate grant here). All wording
// and option shaping live in voiceSettingsModel.ts; this file fetches, saves
// and draws.

import { useState } from 'react';
import {
  Card, Divider, SectionLabel, Select, RadioGroup, Button, InlineAlert, T,
} from '@connorhoehn/ui-components/shared';
import { SettingRow } from '../../components/settings';
import { useFetch } from '../../hooks/useFetch';
import {
  paceOptions, putErrorMessage, putVoiceValue, saveStatusText, sectionVisible, styleOptions, voiceSelect,
  PACE_ROW_HINT, STYLE_ROW_HINT, VOICE_NOTE, VOICE_ROW_HINT,
  type SaveState, type VoiceSettingsBody,
} from './voiceSettingsModel';

const SETTINGS_URL = '/api/voice/settings';

export function VoiceSection() {
  const read = useFetch<VoiceSettingsBody>(SETTINGS_URL);
  // The last body the server answered with, PUT or GET: a save shows at once.
  const [saved, setSaved] = useState<VoiceSettingsBody | null>(null);
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const body = saved ?? read.data;
  const forbidden = read.failure?.kind === 'forbidden';

  if (!sectionVisible({ data: body, forbidden, error: read.error })) return null;

  async function change(patch: { voice?: string | null; style?: string; pace?: string }) {
    if (!body) return;
    const before = body;
    setSaved({ ...body, ...patch });
    setSave({ state: 'pending' });
    try {
      const res = await fetch(SETTINGS_URL, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setSaved(before);
        setSave({ state: 'error', message: putErrorMessage(res.status, json) });
        return;
      }
      setSaved(json as VoiceSettingsBody);
      setSave({ state: 'saved' });
    } catch (e) {
      setSaved(before);
      setSave({ state: 'error', message: e instanceof Error ? e.message : 'the request failed.' });
    }
  }

  const status = saveStatusText(save);

  return (
    <Card padding="md" aria-label="Voice" data-testid="settings-voice">
      <SectionLabel as="div" className="mb-1">Voice</SectionLabel>
      <Divider spacing="none" className="mb-1" />

      {!body ? (
        <InlineAlert tone="error" data-testid="voice-settings-error">
          Could not load your voice settings: {read.error}{' '}
          <Button variant="link" size="sm" className="px-0" onClick={read.refresh}>Try again</Button>
        </InlineAlert>
      ) : (
        <>
          <VoiceRows body={body} pending={save.state === 'pending'} onChange={(p) => { void change(p); }} />
          <T size="xs" tone="secondary" className="block pt-1.5">{VOICE_NOTE}</T>
          {status && (
            <T
              size="xs"
              className={`block pt-1.5 ${save.state === 'error' ? 'text-danger' : save.state === 'saved' ? 'text-success' : 'text-text-tertiary'}`}
              data-testid="voice-settings-status"
            >
              {status}
            </T>
          )}
        </>
      )}
    </Card>
  );
}

function VoiceRows({ body, pending, onChange }: {
  body: VoiceSettingsBody;
  pending: boolean;
  onChange: (patch: { voice?: string | null; style?: string; pace?: string }) => void;
}) {
  const voice = voiceSelect(body);
  return (
    <>
      <SettingRow
        title="Voice"
        description={VOICE_ROW_HINT}
        control={
          <Select
            aria-label="Voice"
            size="sm"
            value={voice.value}
            options={voice.options}
            groups={voice.groups}
            disabled={pending}
            onChange={(e) => onChange({ voice: putVoiceValue(e.target.value) })}
            data-testid="voice-settings-voice"
          />
        }
      />
      <Divider spacing="none" />
      <SettingRow
        title="Speaking style"
        description={STYLE_ROW_HINT}
        control={
          <Select
            aria-label="Speaking style"
            size="sm"
            value={body.style}
            options={styleOptions(body)}
            disabled={pending}
            onChange={(e) => onChange({ style: e.target.value })}
            data-testid="voice-settings-style"
          />
        }
      />
      <Divider spacing="none" />
      <SettingRow
        title="Pace"
        description={PACE_ROW_HINT}
        control={
          <RadioGroup
            name="voice-pace"
            value={body.pace}
            options={paceOptions(body)}
            orientation="horizontal"
            disabled={pending}
            onChange={(v) => onChange({ pace: v })}
            data-testid="voice-settings-pace"
          />
        }
      />
    </>
  );
}
