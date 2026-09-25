// v9 body — reading a file he sent: pdf (pdftotext), docx (the document xml),
// and anything textual. The full text is kept beside the original in her
// house (reading/<name>.txt) so `read_file` can page through it later.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Exec } from './types.js';

export interface ReadResult {
  text: string;
  pages?: number | undefined;
  kind: 'pdf' | 'docx' | 'text' | 'html';
}

const TEXTUAL = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|log|xml|py|js|mjs|ts|tsx|sh|toml|ini|srt|vtt|tex|rtf)$/i;

const stripHtml = (s: string): string =>
  s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

const DOCX_PY = [
  'import sys, zipfile, re',
  'z = zipfile.ZipFile(sys.argv[1])',
  "x = z.read('word/document.xml').decode('utf8', 'replace')",
  "x = re.sub(r'</w:p>', '\\n', x)",
  "x = re.sub(r'<w:tab/>', '\\t', x)",
  "x = re.sub(r'<[^>]+>', '', x)",
  "sys.stdout.write(x)",
].join('\n');

/** The text of a file, or undefined for a kind she can't read (images, archives, audio…). */
export const readFileText = async (exec: Exec, file: string, fileName: string, mime?: string | undefined): Promise<ReadResult | undefined> => {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const r = await exec.run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { timeoutMs: 120_000 });
    if (r.code !== 0) return undefined;
    const raw = Buffer.from(r.stdout).toString('utf8');
    const pages = raw.split('\f').filter((p) => p.trim() !== '').length;
    return { text: raw.replace(/\f/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim(), pages, kind: 'pdf' };
  }
  if (name.endsWith('.docx')) {
    const r = await exec.run('python3', ['-c', DOCX_PY, file], { timeoutMs: 60_000 });
    if (r.code !== 0) return undefined;
    return { text: Buffer.from(r.stdout).toString('utf8').trim(), kind: 'docx' };
  }
  if (/\.html?$/.test(name) || mime === 'text/html') {
    return { text: stripHtml(fs.readFileSync(file, 'utf8')), kind: 'html' };
  }
  if (TEXTUAL.test(name) || (mime !== undefined && mime.startsWith('text/'))) {
    return { text: fs.readFileSync(file, 'utf8').trim(), kind: 'text' };
  }
  return undefined;
};

/** Where the extracted text of a saved file lives. */
export const readingPathFor = (houseRoot: string, savedAbs: string): string => path.join(houseRoot, 'reading', `${path.basename(savedAbs)}.txt`);

export { stripHtml };
