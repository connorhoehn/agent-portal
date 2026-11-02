import base from './ui-dom-audit.adapter';

// Use the same route contracts and read-only probes for the initiative entry.
export default {
  ...base,
  async cases(options: Parameters<typeof base.cases>[0]) {
    return (await base.cases({ ...options, tenant: 'orgiq', path: '/iq/search' }))
      .map(spec => ({ ...spec, path: '/iq/search?scope=p-llm-platform' }));
  },
};
