jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { dmMembers, tenantDmMembers, SOCIAL_DM_PREFIX } from '../social-chat.js';

describe('dmMembers', () => {
  it('parses 2-member and group DM channel names', () => {
    expect(dmMembers('social:dm:u-a:u-b')).toEqual(['u-a', 'u-b']);
    expect(dmMembers('social:dm:u-a:u-b:u-c')).toEqual(['u-a', 'u-b', 'u-c']);
  });
  it('returns null for single-member, malformed, hashed and non-social names', () => {
    expect(dmMembers('social:dm:u-a')).toBeNull();
    expect(dmMembers('social:dm:')).toBeNull();
    expect(dmMembers('social:dmg:abc123')).toBeNull();
    expect(dmMembers('orgiq:dm:u-a:u-b')).toBeNull();
    expect(dmMembers('social:ch:general')).toBeNull();
  });
  it('reads the library parser: an empty member segment or a nested prefix is not a DM (0.109 parseDmLobby)', () => {
    expect(SOCIAL_DM_PREFIX).toBe('social:dm:');
    expect(dmMembers('social:dm:u-a::u-b')).toBeNull();
    expect(dmMembers('social:x:dm:u-a:u-b')).toBeNull();
  });
});

describe('tenantDmMembers', () => {
  it('reads any known tenant DM and nothing else', () => {
    expect(tenantDmMembers('orgiq:dm:u-a:u-b')).toEqual(['u-a', 'u-b']);
    expect(tenantDmMembers('social:dm:u-a:u-b')).toEqual(['u-a', 'u-b']);
    expect(tenantDmMembers('acme:dm:u-a:u-b')).toBeNull();
    expect(tenantDmMembers('orgiq:dmg:abc')).toBeNull();
    expect(tenantDmMembers('orgiq:x:dm:u-a:u-b')).toBeNull();
    expect(tenantDmMembers('orgiq:dm:u-a')).toBeNull();
  });
});
