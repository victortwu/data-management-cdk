import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const MARGIN = 50
const FONT_SIZE = 10
const LINE_HEIGHT = 14
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2
const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN * 2
const LINES_PER_PAGE = Math.floor(USABLE_HEIGHT / LINE_HEIGHT)

export const textToPdf = async (text: string): Promise<Buffer> => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)

  const lines = wrapText(text, font, FONT_SIZE, USABLE_WIDTH)

  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    const pageLines = lines.slice(i, i + LINES_PER_PAGE)
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let y = PAGE_HEIGHT - MARGIN

    for (const line of pageLines) {
      y -= LINE_HEIGHT
      page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) })
    }
  }

  if (doc.getPageCount() === 0) doc.addPage()

  const pdfBytes = await doc.save()
  return Buffer.from(pdfBytes)
}

const wrapText = (
  text: string,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  fontSize: number,
  maxWidth: number,
): string[] => {
  const result: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      result.push('')
      continue
    }
    const words = paragraph.split(' ')
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
        line = test
      } else {
        if (line) result.push(line)
        line = word
      }
    }
    if (line) result.push(line)
  }
  return result
}
