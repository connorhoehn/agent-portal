import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';

// Placeholder badge rendered on nav items that are not yet built.
// The '?' button titleAction is a no-op until the Newsroom help modal
// is wired by a future agent.
function HelpButton() {
  return (
    <button
      type="button"
      aria-label="Newsroom help"
      onClick={() => {
        // TODO(N2): open a help / onboarding modal for the Newsroom section
      }}
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        color: 'var(--color-text-tertiary)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        padding: 0,
      }}
    >
      ?
    </button>
  );
}

const NAV_ITEMS: SubNavItem[] = [
  { path: 'home',     label: 'Home',          hint: 'Today at a glance' },
  { path: 'articles', label: 'Articles',      hint: 'Browse + filter',   count: 'N3' },
  { path: 'beats',    label: 'Beat coverage', hint: 'Heatmap by topic',  count: 'N4' },
  { path: 'briefs',   label: 'Briefs',        hint: 'Generated digests', count: 'N6' },
  { path: 'pitches',  label: 'Pitches',       hint: 'Story backlog',     count: 'N8' },
];

function NewsroomLayout() {
  return (
    <SubNavLayout
      title="Newsroom"
      items={NAV_ITEMS}
      titleAction={<HelpButton />}
    />
  );
}

export default NewsroomLayout;
