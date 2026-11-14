import type { ArchivePolicy } from '../import'
export const DOCUMENT_POLICY: ArchivePolicy = {
  extensions: new Set(['.json', '.pdf', '.png', '.jpg', '.jpeg', '.webp']),
  limits: { archiveBytes: 100 * 1024 ** 2, memberBytes: 100 * 1024 ** 2, members: 8, unpackedBytes: 110 * 1024 ** 2 }
}
