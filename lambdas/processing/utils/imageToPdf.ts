import { PDFDocument } from 'pdf-lib'

export const imageToPdf = async (imageBytes: Buffer, fileType: string): Promise<Buffer> => {
  const doc = await PDFDocument.create()

  let image
  if (fileType === 'image') {
    // Detect format from magic bytes
    if (imageBytes[0] === 0xff && imageBytes[1] === 0xd8) {
      image = await doc.embedJpg(imageBytes)
    } else if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50) {
      image = await doc.embedPng(imageBytes)
    } else {
      // TIFF and other formats: store as-is, Textract handles them directly
      return imageBytes
    }
  } else {
    return imageBytes
  }

  const { width, height } = image.scale(1)
  const page = doc.addPage([width, height])
  page.drawImage(image, { x: 0, y: 0, width, height })

  const pdfBytes = await doc.save()
  return Buffer.from(pdfBytes)
}
