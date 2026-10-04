import { createPublicKey } from 'node:crypto';
import { importPKCS8, decodeJwt, decodeProtectedHeader } from 'jose';
import type { Credentials } from '../types.js';
import { buildToken } from './auth.js';
import { explainNetworkError, fetchWithTimeout } from './client.js';
import { toPem } from './pem.js';

const AUDIENCE = 'appstoreconnect-v1';

export interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

export interface Diagnostics {
  checks: Check[];
  /** Decoded JWT — shows exactly what is being sent to Apple. */
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  /** Start of the public key in base64 — for matching against what Apple displays. */
  publicKeyPreview: string | null;
  /** If the key works with another type, suggests which one to pick in the form. */
  suggestedKeyKind?: 'team' | 'individual' | null;
  hints: string[];
}

/**
 * If the selected key type yields 403, try the opposite one.
 * Team and Individual keys share one signing scheme but differ in payload
 * (`sub: "user"` is only required for individual), so mixing them up is easy —
 * and Apple answers 403. This finds the right type automatically.
 */
async function detectKeyKind(credentials: Credentials): Promise<{
  keyKind: 'team' | 'individual' | null;
  detail: string;
}> {
  const order = (['team', 'individual'] as const).filter(
    (kind) => kind !== (credentials.keyKind ?? 'team'),
  );

  for (const kind of order) {
    const token = await buildToken({ ...credentials, keyKind: kind });
    const result = await probe(token, APPS_PROBE);

    if (result.ok) {
      return {
        keyKind: kind,
        detail: `Access works with the "${kind === 'team' ? 'Team Key' : 'Individual Key'}" type`,
      };
    }
  }

  return { keyKind: null, detail: 'Switching the key type did not help' };
}

interface Probe {
  path: string;
  label: string;
  /** What a success confirms — used to explain the result. */
  means: string;
}

const APPS_PROBE: Probe = {
  path: '/v1/apps?limit=1',
  label: 'Apps',
  means: 'there is access to the team’s app list',
};

/**
 * Probes run from least to most restricted, so it is clear at which level access
 * breaks. /v1/territories needs no permissions — success means the token is fine
 * and the problem is purely about access.
 */
const PROBES: Probe[] = [
  {
    path: '/v1/territories',
    label: 'Territories',
    means: 'token accepted by Apple, authorisation is fine',
  },
  APPS_PROBE,
  {
    path: '/v1/users?limit=1',
    label: 'Users',
    means: 'the key has the Admin/Account Holder role',
  },
];

interface ProbeResult {
  label: string;
  status: number;
  ok: boolean;
  detail: string;
}

async function probe(token: string, probe: Probe): Promise<ProbeResult> {
  try {
    const response = await fetch(`https://api.appstoreconnect.apple.com${probe.path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    const body = (await response.json().catch(() => undefined)) as
      | { errors?: { title?: string; detail?: string }[] }
      | undefined;

    return {
      label: probe.label,
      status: response.status,
      ok: response.ok,
      detail: response.ok
        ? probe.means
        : (body?.errors?.[0]?.detail ?? body?.errors?.[0]?.title ?? 'no description'),
    };
  } catch (error) {
    return {
      label: probe.label,
      status: 0,
      ok: false,
      detail: `network unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Turns probe results into a concrete explanation.
 * Note: a 403 on an Admin key almost never means "not enough permissions" —
 * an Admin has access to everything. The cause is usually something else.
 */
function explain(results: ProbeResult[], credentials: Credentials): string[] {
  const hints: string[] = [];
  const [territories, apps, users] = results;

  if (!territories) {
    return hints;
  }

  // Even Territories fails — the token is not recognised at all.
  if (!territories.ok) {
    if (territories.status === 401) {
      hints.push(
        'Even the basic /v1/territories endpoint rejected the token (401), so this is not about permissions but about the token itself: check the Issuer ID (it must be the 36-character UUID, not the Team ID) and that the .p8 matches the Key ID you entered.',
      );
    } else {
      hints.push(
        `The basic request returned HTTP ${territories.status}. Check network access to api.appstoreconnect.apple.com.`,
      );
    }
    return hints;
  }

  // Token accepted — from here on it is purely about access.
  if (apps?.ok) {
    hints.push(
      'The token is accepted and apps are reachable — the key works. If something specific still will not open, the problem is in that app, not the key.',
    );
  }

  if (apps && !apps.ok && apps.status === 403) {
    hints.push(
      'The key is accepted, but Apple denies access to the app list. For a key with the Admin role this means one of two things: ' +
        '1) the Issuer ID belongs to a different team — it must match your own team; ' +
        '2) the account has no active App Store Agreement, or its status is Pending — the API will not grant app access.',
    );
  }

  if (apps && !apps.ok && apps.status === 404) {
    hints.push(
      'HTTP 404 on the app list: the team and token are fine, but there is no app access. Check that the app was created in this same team.',
    );
  }

  if (users && !users.ok && users.status === 403) {
    // With apps=200 this is normal: the Developer and App Manager roles behave the same way.
    hints.push(
      apps?.ok
        ? 'Access to /v1/users is limited to Admin and Account Holder, so a 403 here is expected and does not break anything. The Developer role is plenty for deleting screenshots.'
        : 'Access to /v1/users is limited to Admin and Account Holder. A 403 here means the key does not have the Admin role — check the role on the Integrations page.',
    );
  }

  if (users?.ok) {
    hints.push('Admin role confirmed: the /v1/users endpoint is reachable, so the key has full permissions.');
  }

  if (hints.length === 0 && credentials.bundleId) {
    hints.push(`Check that the app ${credentials.bundleId} belongs to this same team.`);
  }

  return hints;
}
/** First bytes of the public key: helps confirm the right .p8 was loaded. */
function publicKeyPreview(pem: string): string | null {
  try {
    const spki = createPublicKey(pem).export({ type: 'spki', format: 'pem' }) as string;
    return spki
      .split('\n')
      .filter((line) => line && !line.startsWith('---'))
      .join('')
      .slice(0, 40);
  } catch {
    return null;
  }
}

export async function diagnose(credentials: Credentials): Promise<Diagnostics> {
  const checks: Check[] = [];
  const hints: string[] = [];

  // 1. Issuer ID: a UUID, not a Team ID.
  const issuerOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    credentials.issuerId,
  );
  checks.push({
    ok: issuerOk,
    label: 'Issuer ID',
    detail: issuerOk
      ? `Valid UUID: ${credentials.issuerId}`
      : `"${credentials.issuerId}" is not a UUID. The Issuer ID is the 36-character value from the keys page.`,
  });
  if (!issuerOk && credentials.issuerId.trim().length === 10) {
    hints.push(
      'This looks like a Team ID (10 characters) rather than an Issuer ID. They look similar but are different values — Apple only accepts the Issuer ID.',
    );
  }

  // 2. Key ID: 10 characters, matching the file name.
  const keyIdOk = /^[A-Z0-9]{10}$/i.test(credentials.keyId);
  checks.push({
    ok: keyIdOk,
    label: 'Key ID',
    detail: keyIdOk
      ? `10 characters: ${credentials.keyId}`
      : `"${credentials.keyId}" — expected exactly 10 A-Z0-9 characters.`,
  });

  // 3. Whether the private key can be read.
  const pem = toPem(credentials.privateKey);
  let key: Awaited<ReturnType<typeof importPKCS8>> | null = null;
  try {
    key = await importPKCS8(pem, 'ES256');
    checks.push({ ok: true, label: 'Private key', detail: 'Valid PEM, ECDSA P-256 pair accepted' });
  } catch (error) {
    checks.push({
      ok: false,
      label: 'Private key',
      detail: `Cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const keyPreview = publicKeyPreview(pem);

  if (!key) {
    hints.push(
      'Check the key: the file must be PKCS#8 format (-----BEGIN PRIVATE KEY-----). Copy the full contents of the .p8 without quotes or stray characters.',
    );
    return { checks, header: null, payload: null, publicKeyPreview: keyPreview, hints };
  }

  // 4. Build the token and inspect what will actually be sent to Apple.
  // The same buildToken as in production: diagnostics must not test a different token.
  const token = await buildToken(credentials);

  const header = decodeProtectedHeader(token) as Record<string, unknown>;
  const payload = decodeJwt(token) as Record<string, unknown>;

  checks.push({
    ok: header.alg === 'ES256' && header.kid === credentials.keyId,
    label: 'JWT header',
    detail: `alg=${String(header.alg)}, kid=${String(header.kid)}, typ=${String(header.typ)}`,
  });

  const ttl = Number(payload.exp ?? 0) - Number(payload.iat ?? 0);
  const isIndividual = credentials.keyKind === 'individual';
  // sub is only mandatory for individual keys — a common cause of 401.
  const subOk = isIndividual ? payload.sub === 'user' : true;

  checks.push({
    ok: payload.iss === credentials.issuerId && payload.aud === AUDIENCE && ttl <= 1200 && subOk,
    label: 'JWT payload',
    detail:
      `iss=${String(payload.iss)}, aud=${String(payload.aud)}, TTL=${ttl}s (max 1200)` +
      (isIndividual ? `, sub=${String(payload.sub ?? '—')}` : ', sub not required'),
  });

  // 5. Check the network first — without it every later probe is meaningless.
  let reachable = false;
  try {
    const ping = await fetchWithTimeout(
      'https://api.appstoreconnect.apple.com/v1/territories',
      { headers: { Accept: 'application/json' } },
      15_000,
    );
    // 401 without a token means the network works and the server can hear us.
    reachable = ping.ok || ping.status === 401 || ping.status === 403;
    checks.push({
      ok: reachable,
      label: 'Network to Apple',
      detail: reachable
        ? `api.appstoreconnect.apple.com responds (HTTP ${ping.status} without a token — that is normal)`
        : `Unexpected HTTP ${ping.status}`,
    });
  } catch (error) {
    checks.push({
      ok: false,
      label: 'Network to Apple',
      detail: explainNetworkError(error),
    });
    hints.push(explainNetworkError(error));
    return { checks, header, payload, publicKeyPreview: keyPreview, hints, suggestedKeyKind: null };
  }

  // 6. Try several endpoints: see exactly where access breaks.
  const results: ProbeResult[] = [];
  for (const item of PROBES) {
    results.push(await probe(token, item));
  }

  const summary = results.map((r) => `${r.label}: ${r.ok ? '200' : r.status}`).join(' · ');
  checks.push({
    ok: results[0]?.ok === true,
    label: 'API access',
    detail: summary,
  });

  for (const result of results) {
    checks.push({
      ok: result.ok,
      label: `Probe: ${result.label}`,
      detail: result.ok ? result.detail : `HTTP ${result.status} — ${result.detail}`,
    });
  }

  // Token accepted but no access — try the other key type.
  const appsResult = results[1];
  let suggestedKind: 'team' | 'individual' | null = null;

  if (results[0]?.ok && appsResult && !appsResult.ok && appsResult.status === 403) {
    const detected = await detectKeyKind(credentials);

    checks.push({
      ok: detected.keyKind !== null,
      label: 'Key type',
      detail: detected.detail,
    });

    if (detected.keyKind) {
      suggestedKind = detected.keyKind;
      hints.push(
        `The key type selected in the form is wrong. Choose "${
          detected.keyKind === 'team' ? 'Team Key' : 'Individual Key'
        }" — access works with that.`,
      );
    }
  }

  hints.push(...explain(results, credentials));

  return {
    checks,
    header,
    payload,
    publicKeyPreview: keyPreview,
    hints,
    suggestedKeyKind: suggestedKind,
  };
}