import base from './ui-dom-audit.adapter';

// The ordinary audit's administrator is not a member of #general. This
// read-only variant exercises the joined view without joining a channel.
export default {
  ...base,
  async cases(options: Parameters<typeof base.cases>[0]) {
    return (await base.cases({
      ...options, tenant: 'orgiq', path: options.path ?? '/iq/communication/channels/general?view=shared',
    })).map(spec => ({ ...spec, user: 'u-theo', actor: 'orgiq:u-theo' }));
  },
};
