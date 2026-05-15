export const textToPdfBytes = (text: string): Buffer => {
  const stream = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
4 0 obj<</Length ${20 + text.length}>>stream
BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET
endstream endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`
  return Buffer.from(stream)
}
