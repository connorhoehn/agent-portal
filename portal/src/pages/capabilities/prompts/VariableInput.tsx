import { Input, Textarea } from '@connorhoehnslalom/ui-components/shared';
import { VarCombobox } from './VarCombobox';
import { detectVarType } from './promptFormat';

/** Routes one `{{variable}}` to the control its name implies. */
export function VariableInput({
  name,
  value,
  onChange,
  personOptions,
  skillOptions,
  autoFocus,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  personOptions: string[];
  skillOptions: string[];
  /** The panel that renders this replaced the button that opened it, so its
   *  first field claims focus rather than leaving it on `<body>`. */
  autoFocus?: boolean;
}) {
  switch (detectVarType(name)) {
    case 'person':
      return (
        <VarCombobox
          value={value}
          onChange={onChange}
          options={personOptions}
          placeholder="Select or type a person…"
          autoFocus={autoFocus}
        />
      );
    case 'skill':
      return (
        <VarCombobox
          value={value}
          onChange={onChange}
          options={skillOptions}
          placeholder="Select or type a topic / skill…"
          autoFocus={autoFocus}
        />
      );
    case 'textarea':
      return (
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={`Value for ${name}…`}
          rows={3}
          aria-label={name}
          autoFocus={autoFocus}
        />
      );
    default:
      return (
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={`Value for ${name}…`}
          aria-label={name}
          autoFocus={autoFocus}
        />
      );
  }
}
