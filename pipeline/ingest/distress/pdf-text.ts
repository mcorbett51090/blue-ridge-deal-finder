/**
 * Minimal PDF text extraction — zlib + the text-showing operators, no dependency.
 *
 * Why not a PDF library: the two documents this reads are small, single-purpose
 * county tables whose content streams are plain `/FlateDecode`. `zlib` is in the
 * Node standard library, so this adds no supply-chain surface to a public repo
 * where `.npmrc` already sets `ignore-scripts=true` precisely to keep install
 * time from executing anything.
 *
 * ⛔ WHAT THIS DELIBERATELY DOES NOT DO. It does not attempt OCR. Haywood
 * County's foreclosure documents are scanned images — measured: 0 `/Font`
 * markers, 3 `/DCTDecode` JPEG streams — and there is no text to extract at
 * any price. A caller that gets '' back from a scanned PDF must treat that as
 * "unreadable", never as "no properties listed"; those are different facts and
 * only one of them is about the county.
 */
import zlib from 'node:zlib';

/** True when the document has a text layer at all. 0 `/Font` markers means the
 *  pages are images and every extraction below will legitimately return ''. */
export function hasTextLayer(pdf: Buffer): boolean {
  return /\/Font/.test(pdf.toString('latin1'));
}

/** Decompress every FlateDecode stream and return the concatenated raw content. */
export function rawStreams(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const chunks: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    try {
      chunks.push(zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'));
    } catch {
      // Not every stream is Flate (fonts, images). Skipping one is normal;
      // skipping ALL of them is what `hasTextLayer` exists to distinguish.
    }
  }
  return chunks.join('\n');
}

/**
 * The strings inside PDF text-showing operators, in document order.
 *
 * These county tables are kerned per character — a PIN arrives as
 * `7 6 6 2 - 2 3 - 2 5 9 3` across separate operators — so callers that want
 * a field, not prose, should use `flatten()`.
 */
export function shownText(pdf: Buffer): string {
  const content = rawStreams(pdf);
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[0].slice(1, -1).replace(/\\(.)/g, '$1'));
  }
  return out.join(' ');
}

/** All whitespace removed. Correct for extracting FIELDS (a PIN, a dollar
 *  amount) out of per-character kerning; useless for prose, which is fine —
 *  nothing here wants the prose. */
export function flatten(pdf: Buffer): string {
  return shownText(pdf).replace(/\s+/g, '');
}
