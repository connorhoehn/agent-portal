// Tells the library's PdfViewer where pdf.js's worker script is served: the installed pdfjs-dist's own worker,
// bundled by Vite and served from this app's origin (nothing is loaded from elsewhere). Imported only by
// pages/interviews/ResumeViewer.tsx, so pdf.js stays out of every other page's bundle.

import { setPdfWorkerSrc } from '@connorhoehn/ui-components/pdf-viewer';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

setPdfWorkerSrc(workerUrl);
