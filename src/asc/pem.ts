/**
 * Normalises the contents of a .p8 file into a valid PKCS#8 PEM.
 *
 * The file Apple hands out often arrives with the newlines already collapsed into
 * a single line, so every common variant is reduced to the same shape here.
 */
export function toPem(raw: string): string {
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '\n')
    .trim();

  const base64 = cleaned.replace(/\s+/g, '');

  // Stray quotes from a copy/paste out of a terminal are a common mistake.
  const unquoted = base64.replace(/^["']|["']$/g, '');
  const lines = unquoted.match(/.{1,64}/g) ?? [unquoted];

  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}