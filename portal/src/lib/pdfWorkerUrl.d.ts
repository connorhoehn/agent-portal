// Vite's `?url` import of pdf.js's worker script (this app has no vite-env.d.ts).
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
