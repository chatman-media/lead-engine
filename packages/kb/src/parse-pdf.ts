import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract plain text from a PDF file. Pages are joined with double newlines
 * so paragraph boundaries survive. Throws on corrupt/encrypted files.
 */
export async function parsePdf(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath);
  return parsePdfBuffer(new Uint8Array(buffer));
}

/**
 * Extract plain text directly from a PDF buffer (Uint8Array). Use this when
 * the PDF is already in memory (e.g. HTTP multipart upload) to avoid writing
 * a temporary file.
 *
 * Throws on corrupt or encrypted PDFs.
 */
export async function parsePdfBuffer(buffer: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n\n").trim();
}
