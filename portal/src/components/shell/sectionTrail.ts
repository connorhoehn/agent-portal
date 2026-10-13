import { createContext, useContext } from 'react';

/** True inside a section layout that already draws the breadcrumb trail as the
 * content column's first row (BuildSectionLayout). A page frame that would draw
 * its own trail (CollectionCommandPage) reads this and draws none, so a page
 * never shows two trails and its title stays within 64px of the one trail. */
export const SectionTrailContext = createContext(false);
export const useSectionTrailDrawn = () => useContext(SectionTrailContext);
