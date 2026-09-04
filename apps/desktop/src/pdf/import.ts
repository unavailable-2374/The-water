/**
 * 兼容层：导入逻辑已经搬到 @/documents（不再只认 PDF，也认 TXT / Markdown）。
 * 书架页仍然从这里取 pickPdfFiles / importPdf，这里直接转发到通用实现。
 */
export { absolutePathFor } from '@/documents/open';
export {
  importDocument,
  importDocument as importPdf,
  importDocuments,
  pickDocumentFiles as pickPdfFiles,
  filterImportable,
  type ImportResult,
} from '@/documents/import';

/** 历史目录名：PDF 仍存在 appdata/pdfs 下。 */
export const PDF_DIR = 'pdfs';
