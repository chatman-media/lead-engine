import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract plain text from a PDF file. Pages are joined with double newlines
 * so paragraph boundaries survive. Throws on corrupt/encrypted files.
 */
export async function parsePdf(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n\n").trim();
}
