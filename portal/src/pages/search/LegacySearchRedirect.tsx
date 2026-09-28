import { Navigate, useLocation } from 'react-router';
import { searchMigration } from './searchModel';
export default function LegacySearchRedirect() {
  const location = useLocation();
  return <Navigate to={searchMigration(location.pathname, location.search, location.hash)} replace />;
}
