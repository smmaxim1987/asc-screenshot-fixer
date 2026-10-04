import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './asc/index.js';
import { diagnose } from './asc/diagnose.js';
import { explainNetworkError } from './asc/client.js';
import {
  deleteScreenshot,
  deleteScreenshotSet,
  findApp,
  listApps,
  scanApp,
} from './asc/screenshots.js';
import { HttpError, SessionStore, credentialsSchema } from './session.js';
import type { Credentials } from './types.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();
const sessions = new SessionStore();

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public', { extensions: ['html'] }));

// Screenshots of the problem for the README also appear in the UI.
const README_IMAGE = '59d8c8a0-18dc-43b9-afe7-817903833c6d.png';
app.get(`/${README_IMAGE}`, (_req, res) => res.sendFile(README_IMAGE, { root: process.cwd() }));

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

/**
 * Key diagnostics: runs every check plus one test request to Apple.
 * A session is only created once the token is genuinely accepted.
 */
app.post(
  '/api/diagnose',
  asyncRoute(async (req, res) => {
    const credentials = credentialsFrom(req.body);
    const report = await diagnose(credentials);

    // The key counts as working once apps are reachable — enough for this task.
    const appsCheck = report.checks.find((check) => check.label === 'Probe: Apps');
    const accepted = appsCheck?.ok === true;

    res.json({ ...report, accepted });
  }),
);

/** Reads the session id from the X-Session-Id header or a query parameter. */
function sessionIdOf(req: Request): string | undefined {
  const header = req.header('X-Session-Id');
  return header || (typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined);
}

/** Reads a required path parameter: with noUncheckedIndexedAccess it is string | undefined. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) {
    throw new HttpError(400, `Missing parameter ${name}`);
  }
  return value;
}

function credentialsFrom(body: unknown): Credentials {
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { issuerId, keyId, privateKey, keyKind, bundleId } = parsed.data;
  return { issuerId, keyId, privateKey, keyKind, ...(bundleId ? { bundleId } : {}) };
}

/** Accepts credentials, verifies them against /v1/apps, and creates a session. */
app.post(
  '/api/session',
  asyncRoute(async (req, res) => {
    const session = sessions.create(credentialsFrom(req.body));

    try {
      const requested = session.credentials.bundleId;
      if (requested && !(await findApp(session.client, requested))) {
        sessions.remove(session.id);
        throw new HttpError(404, `No app with bundle ID "${requested}" was found in this account`);
      }

      const apps = await listApps(session.client);
      const selected = requested ? (apps.find((a) => a.bundleId === requested) ?? null) : null;

      res.status(201).json({ sessionId: session.id, apps, selectedApp: selected });
    } catch (error) {
      sessions.remove(session.id);
      throw error;
    }
  }),
);

/** Swapping credentials within an open session. */
app.post(
  '/api/session/validate',
  asyncRoute(async (req, res) => {
    const current = sessions.get(sessionIdOf(req));
    const next = sessions.refresh(current, credentialsFrom(req.body));
    res.json({ sessionId: next.id, apps: await listApps(next.client), selectedApp: null });
  }),
);

app.delete(
  '/api/session',
  asyncRoute(async (req, res) => {
    sessions.remove(sessionIdOf(req) ?? '');
    res.status(204).end();
  }),
);

app.get(
  '/api/apps',
  asyncRoute(async (req, res) => {
    const session = sessions.get(sessionIdOf(req));
    res.json({ apps: await listApps(session.client) });
  }),
);

/** Full screenshot scan for one app. */
app.get(
  '/api/scan',
  asyncRoute(async (req, res) => {
    const session = sessions.get(sessionIdOf(req));
    const appId = typeof req.query.appId === 'string' ? req.query.appId : session.credentials.bundleId;

    if (!appId) {
      throw new HttpError(400, 'appId is required');
    }

    const apps = await listApps(session.client);
    const target = apps.find((candidate) => candidate.id === appId || candidate.bundleId === appId);

    if (!target) {
      throw new HttpError(404, 'App not found');
    }

    res.json(await scanApp(session.client, target));
  }),
);

/** Deletes a single stuck screenshot. */
app.delete(
  '/api/screenshots/:id',
  asyncRoute(async (req, res) => {
    const session = sessions.get(sessionIdOf(req));
    const id = param(req, 'id');
    await deleteScreenshot(session.client, id);
    res.json({ deleted: id });
  }),
);

/** Bulk delete with a per-id report. */
app.post(
  '/api/screenshots/delete',
  asyncRoute(async (req, res) => {
    const session = sessions.get(sessionIdOf(req));
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : [];
    const targets = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (targets.length === 0) {
      throw new HttpError(400, 'No screenshot IDs were provided');
    }
    if (targets.length > 200) {
      throw new HttpError(400, 'At most 200 screenshots can be deleted at once');
    }

    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of targets) {
      try {
        await deleteScreenshot(session.client, id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof ApiError ? error.message : String(error) });
      }
    }

    res.json({
      requested: targets.length,
      deleted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  }),
);

/** Drops a whole screenshot set so it can be recreated from scratch. */
app.delete(
  '/api/screenshot-sets/:id',
  asyncRoute(async (req, res) => {
    const session = sessions.get(sessionIdOf(req));
    const id = param(req, 'id');
    await deleteScreenshotSet(session.client, id);
    res.json({ deleted: id });
  }),
);

const AUTH_HELP =
  'Apple returned 401, which means the token itself was rejected. Check: 1) Issuer ID is the 36-character UUID from the keys page (not the 10-character Team ID); ' +
  '2) the .p8 matches the Key ID you entered; 3) the key has not been revoked. Press "Check key" to see exactly what is wrong.';

/**
 * A 403 on an Admin-role key almost never means insufficient permissions:
 * it is usually a different team (Issuer ID) or a missing active agreement.
 */
const ROLE_HELP =
  'Apple returned 403. If your key has the Admin role, check: 1) the Issuer ID belongs to your team; ' +
  '2) App Store Connect has a valid, signed App Store Agreement with no holds; ' +
  '3) the app was created in that same team. Press "Check key" for details.';

/** Single error handler: Apple errors are surfaced with Apple’s own wording. */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  if (error instanceof ApiError) {
    // Status 0 = network failure: the request never reached Apple, the key is irrelevant.
    if (error.status === 0) {
      res.status(503).json({ error: error.message, kind: 'network' });
      return;
    }

    // A 403 mentioning GET_COLLECTION is a wrong endpoint, not a permissions problem.
    if (error.status === 403 && /GET_COLLECTION/.test(error.message)) {
      res.status(501).json({
        error: `Apple does not allow this operation on the resource: ${error.message}`,
        kind: 'unsupported',
      });
      return;
    }
    // 401 means the token was rejected, 403 means permissions are missing — different problems, different advice.
    if (error.status === 401) {
      res.status(401).json({ error: AUTH_HELP, detail: error.message, kind: 'auth' });
      return;
    }
    if (error.status === 403) {
      res.status(403).json({
        error: ROLE_HELP,
        detail: error.message,
        kind: 'role',
      });
      return;
    }
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error('[asc]', error);
  res.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' });
});

app.listen(PORT, HOST, () => {
  console.log('\n  ASC Screenshot Reset');
  console.log(`  → http://${HOST}:${PORT}\n`);
  console.log('  Enter Issuer ID, Key ID and the .p8 contents — keys are kept in memory only.\n');
});