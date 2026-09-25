// Glyphs the mockup needs and the library does not ship yet (terminal, flask,
// download, monitor, join, drive, book, more). Prototype-only: if the direction
// lands, these belong in ui-components' Icons next to the others — queue them
// in docs/ui-components-queue.md rather than copying this file into the app.
import React from 'react';
const svg=(size:number,children:React.ReactNode,stroke=1.8)=><svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
export const TerminalGlyph=({size=16}:{size?:number})=>svg(size,<><path d="M5 7l5 5-5 5"/><path d="M12 17h7"/></>);
export const FlaskGlyph=({size=22}:{size?:number})=>svg(size,<><path d="M9 3h6"/><path d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/></>,1.6);
export const PackageGlyph=({size=22}:{size?:number})=>svg(size,<><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></>,1.6);
export const DownloadGlyph=({size=16}:{size?:number})=>svg(size,<><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></>);
export const MonitorGlyph=({size=17}:{size?:number})=>svg(size,<><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></>);
export const JoinGlyph=({size=17}:{size?:number})=>svg(size,<><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M18 8v6"/><path d="M15 11h6"/></>);
export const LinkGlyph=({size=16}:{size?:number})=>svg(size,<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>);
export const MoreGlyph=({size=17}:{size?:number})=><svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>;
export const ChevronDownGlyph=({size=15}:{size?:number})=>svg(size,<path d="M6 9l6 6 6-6"/>,2);
export const PopOutGlyph=({size=14}:{size?:number})=>svg(size,<><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>);
export const DocGlyph=({size=16}:{size?:number})=>svg(size,<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></>,1.6);
export const BookGlyph=({size=18}:{size?:number})=>svg(size,<><path d="M12 6c-2-1.5-5-2-8-1.5V19c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V4.5c-3-.5-6 0-8 1.5z"/><path d="M12 6v14.5"/></>,1.6);
export const AgentGlyph=({size=15}:{size?:number})=>svg(size,<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></>,1.6);
export const ChatBubbleGlyph=({size=15}:{size?:number})=>svg(size,<circle cx="12" cy="12" r="8"/>,2);
// Google Drive's three-colour mark, as the mockup shows it in the composer.
export const DriveGlyph=({size=20}:{size?:number})=><svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 3h7.6l6.2 10.7h-7.6z" fill="#FBBC04"/><path d="M8.2 3L2 13.7l3.8 6.6 6.2-10.7z" fill="#34A853"/><path d="M5.8 20.3h12.4l3.8-6.6H9.6z" fill="#4285F4"/></svg>;
