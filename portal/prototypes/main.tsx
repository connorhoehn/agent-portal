// Prototype entry. One prototype per module under `prototypes/`; swap the
// import to look at a different one.
//
// `app.css` rather than the library's own stylesheet: it is the token sheet
// the real portal paints from, so a prototype cannot drift into colours the
// product could not reproduce.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/app.css';
import { ComputerLabChat } from './ComputerLabChat';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ComputerLabChat />
  </StrictMode>,
);
