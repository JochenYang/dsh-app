import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Compute the sha512 hex digest of a file. */
export async function sha512File(file: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

export function verifyIntegrity(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase()
}
