/**
 * EMAIL BODY EXTRACTION (pure, no AWS)
 * ────────────────────────────────────────────────────────────────────────────
 * Deliberate HTML→human-readable-text extraction for the Parsely Email Lambda.
 *
 * Fixes bug .kiro/specs/bug-html-email-text-extraction.md: previously the Lambda
 * wrote `mailparser`'s incidental, lossy `parsed.text` for HTML mail — noisy
 * (CSS/script/tracking) and risking dropped financial signal → missed expenses.
 *
 * Behavior:
 *   - HTML-first: when `parsed.html` is present, extract via `html-to-text`
 *     (skip img/style/script/head, keep anchor TEXT but drop tracking hrefs),
 *     then clean.
 *   - Fallback: plain-text-only mail uses `parsed.text` (also cleaned).
 *
 * Cleaning strips zero-width spacers + nbsp variants, collapses whitespace, and
 * removes inbox-preheader chrome lines (not document content).
 *
 * Logic ported verbatim from the proven reference in
 * `scripts/build-intent-fixtures.ts` so ingestion matches the intent-eval
 * fixtures. Copied (not imported) to keep the Email Lambda self-contained.
 */
import { convert } from 'html-to-text'
import { ParsedMail } from 'mailparser'

/**
 * html-to-text convert options: skip non-content nodes and keep anchor TEXT
 * while dropping tracking URLs.
 */
export const HTML_TO_TEXT_OPTS = {
  wordwrap: false as const,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { ignoreHref: true } }, // keep anchor TEXT, drop tracking URLs
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'head', format: 'skip' },
  ],
}

/** Inbox-preview chrome (not document content). */
export const CHROME: RegExp[] = [
  /^additional information inside\.?$/i,
  /^view online$/i,
  /^view in browser$/i,
  /^change who receives emails$/i,
  /^sent to:/i,
]

/** Clean extracted text: strip zero-width/nbsp spacer runs + chrome, collapse space. */
export const cleanExtracted = (raw: string): string =>
  raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width chars (incl U+200C used as spacers)
    .replace(/[\u00A0\u2007\u202F]/g, ' ') // nbsp variants → space
    .split('\n')
    .map((l) => l.replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 0 && !CHROME.some((rx) => rx.test(l)))
    .join('\n')

/**
 * Extract clean, human-readable body text from a parsed email.
 * HTML-first (the fixed-ingestion behavior); falls back to plain text.
 */
export const extractEmailBody = (parsed: Pick<ParsedMail, 'html' | 'text'>): string => {
  if (parsed.html) return cleanExtracted(convert(parsed.html, HTML_TO_TEXT_OPTS))
  return cleanExtracted(parsed.text ?? '')
}
