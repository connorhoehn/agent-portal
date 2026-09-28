import { Navigate, useLocation } from 'react-router';
import { migratePromotionsUrl, promotionReviewHref } from '../distillation/distillationRoutes';

export default function PromotionsLegacyRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={migratePromotionsUrl(pathname, search, hash) ?? promotionReviewHref(search)} replace />;
}
