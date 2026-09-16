// Pure derivations shared by the ingest pages. Currently just the KB
// ingestion-job status → Chip tone table, which SchedulesPage.tsx and
// DataSourcesPage.tsx each declared byte-identically — centralised here so
// the two can't quietly drift apart on what COMPLETE/FAILED/etc. means.

export const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETE: 'success', IN_PROGRESS: 'warning', STARTING: 'warning', FAILED: 'danger', STOPPED: 'neutral',
};
