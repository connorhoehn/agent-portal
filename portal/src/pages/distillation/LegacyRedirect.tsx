// Redirects a pre-redesign Distillation URL (/overview, /tiers, /artifacts,
// /lineage, /compactions, and the bare module root) to its Knowledge /
// Activity equivalent, keeping filters and the selected record. The mapping
// is distillationRoutes.migrateDistillationUrl — this only applies it.
import { Navigate, useLocation } from 'react-router';
import { knowledgeHref, migrateDistillationUrl } from './distillationRoutes';

export default function DistillationLegacyRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={migrateDistillationUrl(pathname, search) ?? knowledgeHref()} replace />;
}
