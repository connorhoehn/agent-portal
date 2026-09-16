// Critical-path panels for the Explore page.
//
// This file WAS all five panels plus a BFS plus three inlined derivations in
// one 660-line module styled entirely with inline `style={{…}}`. Each panel now
// has its own file beside this one, the pure parts live in connectionPath.ts
// and graphInsights.ts, and the two overlay shapes ui-components does not have
// yet are in graphOverlay.tsx.
//
// It stays as a barrel because ExplorePage imports all six names from this
// path. The public interface is unchanged — same names, same props.

export { GraphSearchBox } from './GraphSearchBox';
export type { GraphSearchBoxProps } from './GraphSearchBox';

export { PersonDetailCard } from './PersonDetailCard';
export type { PersonDetailCardProps } from './PersonDetailCard';

export { ConnectionPathStrip } from './ConnectionPathStrip';
export type { ConnectionPathStripProps } from './ConnectionPathStrip';

export { DepartmentChips } from './DepartmentChips';
export type { DepartmentChipsProps } from './DepartmentChips';

export { DepartmentInsightStrip } from './DepartmentInsightStrip';
export type { DepartmentInsightStripProps } from './DepartmentInsightStrip';

export { indexBusFactorFindings } from './graphInsights';
export type { FindingLike } from './graphInsights';

export { findConnectionPath } from './connectionPath';
export type { PathHop } from './connectionPath';
