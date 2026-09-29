// The assessment tenant's route parent.
//
// This used to render a SubNavLayout with the Assess / Analyze / Informatics /
// System groups inside the page, beneath a shell rail that showed one
// "Assessment" entry. Two navs for one product. The tenant's hierarchy now IS
// the shell rail (see NAV_ITEMS in components/shell/Layout.tsx), the way the
// source app's sidebar is its only navigation, so this parent mounts the child
// route — inside the tenant's call host.
//
// The call host is the orgiq shell's (projects/InitiativeCallHost): one
// `useConversationCall` for every assessment page, so a document call keeps
// going while you move between pages, and an incoming ring reaches you on any
// of them. The host opens an initiative when a ring names one; a ring for a
// DOCUMENT names its URL instead (knowledge/useDocumentCall), and
// DocumentCallNavigator opens it on Accept.

import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { InitiativeCallHost, useInitiativeCallHost } from '../projects/InitiativeCallHost';
import { hrefFromCallChannel } from './knowledge/documentCommentsModel';

function DocumentCallNavigator() {
  const host = useInitiativeCallHost();
  const navigate = useNavigate();
  const location = useLocation();
  const handled = useRef<string | null>(null);
  const lobby = host?.lobby ?? null;
  useEffect(() => {
    const href = hrefFromCallChannel(lobby?.channel);
    if (!lobby || !href || handled.current === lobby.lobbyName) return;
    handled.current = lobby.lobbyName;
    // A page that bound this lobby is already the document; only a ring
    // answered elsewhere moves you.
    const target = new URL(href, 'http://app.local');
    const onIt = location.pathname === target.pathname
      && new URLSearchParams(location.search).get('doc') === target.searchParams.get('doc');
    if (!onIt) navigate(href);
  }, [lobby, location.pathname, location.search, navigate]);
  return null;
}

export default function AssessmentLayout() {
  return <InitiativeCallHost><DocumentCallNavigator /><Outlet /></InitiativeCallHost>;
}
