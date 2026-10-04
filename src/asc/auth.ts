import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import type { Credentials } from '../types.js';
import { toPem } from './pem.js';

const AUDIENCE = 'appstoreconnect-v1';
/** Apple rejects tokens longer than 20 minutes; 19 leaves some headroom. */
const TOKEN_TTL_SECONDS = 19 * 60;

export class AuthError extends Error {
  override readonly name = 'AuthError';
}

/** The return type of importPKCS8 — an opaque "key" as far as jose is concerned. */
type EscKey = Awaited<ReturnType<typeof importPKCS8>>;

interface CacheEntry {
  token: string;
  expiresAt: number;
  /** The fingerprint this token was issued for — guards against handing out someone else's token. */
  fingerprint: string;
}

let cached: CacheEntry | null = null;

/** Identifies a credential set: a token is only ever cached for its own inputs. */
function fingerprintOf(credentials: Credentials): string {
  return createHash('sha256')
    .update(`${credentials.keyKind ?? 'team'}:${credentials.issuerId}:${credentials.keyId}:${credentials.privateKey}`)
    .digest('hex');
}

async function loadKey(credentials: Credentials): Promise<EscKey> {
  try {
    return await importPKCS8(toPem(credentials.privateKey), 'ES256');
  } catch (error) {
    throw new AuthError(
      `Could not read the .p8 private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Builds the JWT. The key difference between Team and Individual keys is the `sub`
 * claim: for an individual key it is mandatory and always "user".
 */
export async function buildToken(credentials: Credentials): Promise<string> {
  const key = await loadKey(credentials);
  const issuedAt = Math.floor(Date.now() / 1000);

  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })
    .setIssuer(credentials.issuerId)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TOKEN_TTL_SECONDS);

  if (credentials.keyKind === 'individual') {
    jwt = jwt.setSubject('user');
  }

  return jwt.sign(key);
}

/** Returns a valid JWT, reusing the cache until the token expires. */
export async function getToken(credentials: Credentials): Promise<string> {
  const fingerprint = fingerprintOf(credentials);

  if (cached && cached.expiresAt > Date.now() && cached.fingerprint === fingerprint) {
    return cached.token;
  }

  const token = await buildToken(credentials);

  cached = {
    token,
    fingerprint,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 - 30_000,
  };
  return token;
}

/** Clears the cache — e.g. when credentials change or after a 401 from Apple. */
export function invalidateToken(): void {
  cached = null;
}

/**
 * Lenient shape check: rejects empty fields and obvious junk.
 * Semantic checks live in diagnose(), which produces a useful report.
 */
export function assertCredentialsShape(credentials: Credentials): void {
  if (!credentials.issuerId.trim()) {
    throw new AuthError('Issuer ID is required');
  }
  if (!credentials.keyId.trim()) {
    throw new AuthError('Key ID is required');
  }
  if (!credentials.privateKey.trim()) {
    throw new AuthError(
      'Paste the full contents of the .p8 file, including the BEGIN/END PRIVATE KEY lines, or upload the file with the button above',
    );
  }
}