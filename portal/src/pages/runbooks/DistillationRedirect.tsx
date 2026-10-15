// The retired /iq/distillation tree: every path lands on its runbooks page,
// with a guide's old ?item= carried to the runbook the migration made of it
// (runbooksModel.distillationRedirect).
import { Navigate, useLocation } from 'react-router';
import { distillationRedirect } from './runbooksModel';

export default function RunbooksDistillationRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={distillationRedirect(pathname, search)} replace />;
}
