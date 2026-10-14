import { simpleParser } from 'mailparser'

import { extractEmailBody } from '../../lambdas/email/extractBody'

/**
 * Unit tests for the Email Lambda's HTML-first body extractor.
 * Covers bug .kiro/specs/bug-html-email-text-extraction.md: HTML emails must
 * yield clean, human-readable text with financial signal preserved and inbox
 * chrome / zero-width / nbsp artifacts removed; plain-text-only mail falls back
 * to parsed.text.
 */

// Zero-width + nbsp spacers used by real preheaders to pad the inbox preview.
const ZW = '\u200B\u200C\u200D\uFEFF'
const NBSP = '\u00A0'

// Representative Liberty-Mutual-style HTML reminder: style block, tracking
// anchor, inbox preheader chrome, and the real financial signal ($325.17 on
// 6/23/2026) buried among zero-width spacers + nbsp.
const lmReminderHtml = `<!DOCTYPE html>
<html>
<head>
  <style>
    @font-face { font-family: 'LMFont'; src: url('font.woff2'); }
    .disclaimerBlueLink { color: #0033a0; text-decoration: none; }
    .preheader { display: none; max-height: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div class="preheader">Additional information inside.${ZW}${NBSP}${ZW}${NBSP}${ZW}</div>
  <div><a href="https://track.libertymutual.com/o/eJx1k?_t=abc123">View online</a></div>
  <img src="https://track.libertymutual.com/pixel.gif" width="1" height="1" />
  <p>Hello,</p>
  <p>This is a friendly reminder that your payment of ${NBSP}$325.17${ZW} will be
     automatically withdrawn from your account on 6/23/2026.</p>
  <table>
    <tr><td>PAYMENT AMOUNT:</td><td>${NBSP}$325.17</td></tr>
    <tr><td>PAYMENT DATE:</td><td>6/23/2026</td></tr>
  </table>
  <div><a href="https://track.libertymutual.com/unsub?u=xyz">change who receives emails</a></div>
  <div>Sent to: policyholder@example.com</div>
  <script>console.log('tracking beacon')</script>
</body>
</html>`

const buildMime = (opts: { html?: string; text?: string }): string => {
  if (opts.html && opts.text) {
    const boundary = 'BOUNDARY_MIXED_42'
    return [
      'From: Liberty Mutual <noreply@libertymutual.com>',
      'To: policyholder@example.com',
      'Subject: Reminder: Your payment will be withdrawn on 6/23/2026',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      '',
      opts.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      '',
      opts.html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n')
  }
  if (opts.html) {
    return [
      'From: Liberty Mutual <noreply@libertymutual.com>',
      'To: policyholder@example.com',
      'Subject: Reminder: Your payment will be withdrawn on 6/23/2026',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="utf-8"',
      '',
      opts.html,
      '',
    ].join('\r\n')
  }
  return [
    'From: Vendor <billing@vendor.example>',
    'To: ap@example.com',
    'Subject: Invoice 1234',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    opts.text ?? '',
    '',
  ].join('\r\n')
}

describe('extractEmailBody', () => {
  it('extracts clean financial signal from an HTML email ($325.17 + 6/23/2026)', async () => {
    const parsed = await simpleParser(buildMime({ html: lmReminderHtml }))
    const body = extractEmailBody(parsed)

    // (a) financial signal present
    expect(body).toContain('$325.17')
    expect(body).toContain('6/23/2026')
    expect(body).toContain('PAYMENT AMOUNT:')
    expect(body).toContain('PAYMENT DATE:')
  })

  it('removes inbox-preheader chrome lines', async () => {
    const parsed = await simpleParser(buildMime({ html: lmReminderHtml }))
    const body = extractEmailBody(parsed)

    // (b) chrome removed
    expect(body).not.toMatch(/Additional information inside\.?/i)
    expect(body).not.toMatch(/^view online$/im)
    expect(body).not.toMatch(/^change who receives emails$/im)
    expect(body).not.toMatch(/^sent to:/im)
  })

  it('strips zero-width and nbsp artifacts and CSS/script noise', async () => {
    const parsed = await simpleParser(buildMime({ html: lmReminderHtml }))
    const body = extractEmailBody(parsed)

    // (c) zero-width / nbsp artifacts gone
    expect(body).not.toMatch(/[\u200B-\u200D\uFEFF]/)
    expect(body).not.toMatch(/[\u00A0\u2007\u202F]/)
    // CSS and script noise excluded
    expect(body).not.toContain('@font-face')
    expect(body).not.toContain('disclaimerBlueLink')
    expect(body).not.toContain('tracking beacon')
    // tracking hrefs dropped (anchor TEXT may remain, URL must not)
    expect(body).not.toContain('track.libertymutual.com')
  })

  it('falls back to parsed.text for a plain-text-only email', async () => {
    const text = 'Invoice 1234\nAmount due: $42.00\nDue date: 7/1/2026\nThank you for your business.'
    const parsed = await simpleParser(buildMime({ text }))

    expect(parsed.html).toBeFalsy()

    const body = extractEmailBody(parsed)
    expect(body).toContain('$42.00')
    expect(body).toContain('7/1/2026')
    expect(body).toContain('Invoice 1234')
  })

  it('prefers HTML over the auto-generated plain-text alternative', async () => {
    // multipart/alternative with a deliberately degraded text part — the HTML
    // part carries the real signal and must win.
    const parsed = await simpleParser(
      buildMime({ html: lmReminderHtml, text: 'View online  Additional information inside.' }),
    )
    expect(parsed.html).toBeTruthy()

    const body = extractEmailBody(parsed)
    expect(body).toContain('$325.17')
    expect(body).toContain('6/23/2026')
  })
})
