// The dev flag opens shortcuts only outside production, and "production" is
// read forgivingly: any case, padded, or the short `prod`.
import { assertDevShortcutAllowed, insecureDevMode, isProductionEnv } from '../insecure-dev-mode.js';

const on = (NODE_ENV?: string) => ({ INSECURE_DEV_MODE: 'true', ...(NODE_ENV === undefined ? {} : { NODE_ENV }) });

describe('insecureDevMode', () => {
  it.each(['production', 'Production', 'PRODUCTION', ' production ', 'production\n', 'prod', 'Prod', ' PROD '])(
    'NODE_ENV=%j vetoes the flag', (value) => {
      expect(isProductionEnv({ NODE_ENV: value })).toBe(true);
      expect(insecureDevMode(on(value))).toBe(false);
    },
  );

  it.each(['development', 'test', '', 'staging', 'productionish'])('NODE_ENV=%j leaves the flag on', (value) => {
    expect(insecureDevMode(on(value))).toBe(true);
  });

  it('needs the flag itself (trimmed, any case)', () => {
    expect(insecureDevMode({ NODE_ENV: 'development' })).toBe(false);
    expect(insecureDevMode({ INSECURE_DEV_MODE: ' TRUE ', NODE_ENV: 'development' })).toBe(true);
    expect(insecureDevMode({ INSECURE_DEV_MODE: '1', NODE_ENV: 'development' })).toBe(false);
  });
});

describe('assertDevShortcutAllowed', () => {
  it('refuses a shortcut under any spelling of production', () => {
    for (const NODE_ENV of ['Production', ' prod ']) {
      expect(() => assertDevShortcutAllowed('AUTH_DEMO_MODE', { AUTH_DEMO_MODE: 'true', INSECURE_DEV_MODE: 'true', NODE_ENV }))
        .toThrow(/not allowed in production/);
    }
  });

  it('allows it under the flag outside production, and refuses it without the flag', () => {
    expect(() => assertDevShortcutAllowed('AUTH_DEMO_MODE', { AUTH_DEMO_MODE: 'true', INSECURE_DEV_MODE: 'true', NODE_ENV: 'development' }))
      .not.toThrow();
    expect(() => assertDevShortcutAllowed('AUTH_DEMO_MODE', { AUTH_DEMO_MODE: 'true', NODE_ENV: 'development' }))
      .toThrow(/requires INSECURE_DEV_MODE/);
    expect(() => assertDevShortcutAllowed('AUTH_DEMO_MODE', {})).not.toThrow();
  });
});
