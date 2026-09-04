import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { convertFileSrc } from '@tauri-apps/api/core';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const base = (p: string) => new URL(p, window.location.href).toString();

export { pdfjs };

export async function openPdf(absPath: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    url: convertFileSrc(absPath),
    cMapUrl: base('/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: base('/pdfjs/standard_fonts/'),
    wasmUrl: base('/pdfjs/wasm/'),
    iccUrl: base('/pdfjs/iccs/'),
  });
  return task.promise;
}

export async function openPdfFromBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: base('/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: base('/pdfjs/standard_fonts/'),
    wasmUrl: base('/pdfjs/wasm/'),
    iccUrl: base('/pdfjs/iccs/'),
  }).promise;
}

/** Release worker resources for a loaded document. */
export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  try {
    await doc.loadingTask.destroy();
  } catch {
    /* already destroyed */
  }
}
