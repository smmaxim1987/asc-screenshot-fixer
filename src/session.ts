import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AscClient, assertCredentialsShape, invalidateToken } from './asc/index.js';
import type { Credentials } from './types.js';

export const credentialsSchema = z.object({
  issuerId: z.string().trim().min(1, 'Issuer ID is required'),
  keyId: z.string().trim().min(1, 'Key ID is required'),
  privateKey: z.string().trim().min(1, 'Paste the contents of the .p8 file'),
  keyKind: z.enum(['team', 'individual']).default('team'),
  bundleId: z.string().trim().optional(),
});

export interface Session {
  id: string;
  credentials: Credentials;
  client: AscClient;
  createdAt: number;
}

/**
 * Keys live in the process memory only, for as long as the server runs: the .p8
 * is never written to disk. Sessions expire so old keys do not linger in RAM.
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class SessionStore {
  readonly #sessions = new Map<string, Session>();

  create(credentials: Credentials): Session {
    assertCredentialsShape(credentials);
    invalidateToken();

    const session: Session = {
      id: randomUUID(),
      credentials,
      client: new AscClient(credentials),
      createdAt: Date.now(),
    };

    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session {
    if (!id) {
      throw new HttpError(400, 'Missing session id');
    }

    const session = this.#sessions.get(id);
    if (!session) {
      throw new HttpError(404, 'Session not found, or the server was restarted — re-enter your credentials');
    }
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.#sessions.delete(id);
      throw new HttpError(401, 'Session expired — re-enter your credentials');
    }

    return session;
  }

  remove(id: string): void {
    this.#sessions.delete(id);
  }

  /** Clears the token cache — e.g. when the client switches credentials. */
  refresh(session: Session, credentials: Credentials): Session {
    this.remove(session.id);
    return this.create(credentials);
  }
}

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}