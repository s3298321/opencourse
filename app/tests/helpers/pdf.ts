/** Small real PDFs for extraction and rendering checks; no external generator. */
export function fixturePdf({ pages = 3, bookmarks = true, text = true }: { pages?: number; bookmarks?: boolean; text?: boolean } = {}): Buffer {
  const objects: string[] = []
  const put = (body: string): number => { objects.push(body); return objects.length }
  put(`<< /Type /Catalog /Pages 2 0 R${bookmarks ? ` /Outlines ${4 + pages * 2} 0 R` : ''} >>`)
  put(`<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`)
  put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (let index = 0; index < pages; index++) {
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`)
    const content = text ? `BT /F1 24 Tf 50 730 Td (Chapter ${index + 1}: Local reading) Tj /F1 12 Tf 0 -40 Td (The document stays local. Searchable phrase on page ${index + 1}.) Tj 0 -24 Td (Ask retrieves a bounded passage, never the entire PDF.) Tj ET` : ''
    put(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  if (bookmarks) {
    const root = objects.length + 1
    put(`<< /Type /Outlines /First ${root + 1} 0 R /Last ${root + pages} 0 R /Count ${pages} >>`)
    for (let index = 0; index < pages; index++) put(`<< /Title (Chapter ${index + 1}) /Parent ${root} 0 R /Dest [${4 + index * 2} 0 R /XYZ 0 760 0]${index ? ` /Prev ${root + index} 0 R` : ''}${index < pages - 1 ? ` /Next ${root + index + 2} 0 R` : ''} >>`)
  }
  let pdf = '%PDF-1.7\n', offsets = [0]
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n` }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf)
}
