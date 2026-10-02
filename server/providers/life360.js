import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { admitLocalRosterRequest } from '../../src/keySetupCore.mjs';
import { readRequestBodyCapped } from './common/request.js';
import {
  buildChaserPlacefile,
  chaserPositions,
  chaserRoster,
  createLife360Client,
  normalizeSelection,
  parseAllowlist,
} from './life360/core.js';

/**
 * Team chasers from the Life360 chase circle — the former standalone
 * life360_placefile.py, folded into this server so one process runs it all.
 * See ./life360/core.js for throttling, health and privacy rules.
 *
 * Routes:
 *   GET /api/chasers        → {configured, health, chasers: [{id, name, lat, lon, fixMs, battery}]}
 *   GET /api/chasers/health → {status, detail, chasers, seconds_since_ok} (503 on FAIL)
 *   GET /chasers.txt        → GRLevelX placefile for Supercell Wx; its ?lat=&lon=
 *                             anchors the health banner, exactly as before
 *   GET  /api/chasers/roster    → picker roster {mode, roster: [{id, label, hasFix, shown}]}
 *   POST /api/chasers/selection → save {ids} (empty = everyone) or {reset: true}
 *
 * The picker routes answer ONLY the machine running the server (the same
 * admitLocalRosterRequest gate as Provider Settings: loopback, local Host, exact
 * Origin, JSON body), so with HOST=0.0.0.0 a LAN visitor can see the map but
 * cannot change who is on it. The selection is saved by member id to
 * .gev-cache/chaser-selection.json and applies to BOTH outputs.
 *
 * Unconfigured (no LIFE360_TOKEN): /api/chasers → {configured:false}, and
 * Life360 is never contacted. The token is read here, server-side only.
 *
 * @returns {import('vite').Plugin}
 */
export function life360ChasersProxy({
  selectionPath = path.join(
    process.cwd(),
    '.gev-cache',
    'chaser-selection.json',
  ),
} = {}) {
  const ROUTES = new Set([
    '/api/chasers',
    '/api/chasers/health',
    '/chasers.txt',
  ]);
  const PICKER_ROUTES = new Set([
    '/api/chasers/roster',
    '/api/chasers/selection',
  ]);
  /** @type {{ids: string[]}|null|undefined} undefined = not read yet; null = no saved pick */
  let selection;
  const readSelection = () => {
    if (selection !== undefined) return selection;
    try {
      const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
      selection = Array.isArray(parsed?.ids)
        ? { ids: parsed.ids.filter((id) => typeof id === 'string') }
        : null;
    } catch {
      selection = null;
    }
    return selection;
  };
  const writeSelection = async (next) => {
    if (next) {
      await fsp.mkdir(path.dirname(selectionPath), { recursive: true });
      await fsp.writeFile(
        selectionPath,
        JSON.stringify({ ids: next.ids, savedAt: new Date().toISOString() }),
        'utf8',
      );
    } else {
      await fsp.rm(selectionPath, { force: true });
    }
    selection = next;
  };
  const visibility = () => ({
    selection: readSelection(),
    allowlist: parseAllowlist(process.env.CHASER_ALLOWLIST),
  });

  let client = null;
  let clientKey = '';
  const getClient = () => {
    const token = String(process.env.LIFE360_TOKEN || '').trim();
    if (!token) return null;
    const circleFilter =
      String(process.env.LIFE360_CIRCLE || '').trim() || null;
    const key = `${token}|${circleFilter}`;
    if (!client || clientKey !== key) {
      client = createLife360Client({
        token,
        circleFilter,
        log: (msg) => console.warn(`[life360] ${msg}`),
      });
      clientKey = key;
    }
    return client;
  };
  const send = (res, status, type, body) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };
  const sendJson = (res, status, obj) =>
    send(res, status, 'application/json', JSON.stringify(obj));

  const handlePicker = async (req, res, pathname) => {
    const admitted = admitLocalRosterRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env: process.env,
    });
    if (!admitted.ok) {
      sendJson(res, admitted.status, {
        error: 'The chaser picker only works on the machine running the server',
      });
      return;
    }
    const expected = pathname === '/api/chasers/roster' ? 'GET' : 'POST';
    if (req.method !== expected) {
      sendJson(res, 405, { error: `Use ${expected}` });
      return;
    }
    const life360 = getClient();
    if (!life360) {
      sendJson(res, 200, { configured: false, mode: 'everyone', roster: [] });
      return;
    }
    try {
      const members = await life360.getMembers();
      if (pathname === '/api/chasers/selection') {
        let body;
        try {
          body = JSON.parse(
            (await readRequestBodyCapped(req, 64 * 1024)).toString('utf8'),
          );
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        if (body?.reset === true) {
          await writeSelection(null);
        } else {
          if (!members.length) {
            sendJson(res, 409, {
              error: 'No roster yet — Life360 has not answered',
            });
            return;
          }
          const next = normalizeSelection(
            body,
            members.map((m) => String(m.id)),
          );
          if (!next) {
            sendJson(res, 400, {
              error: 'Expected {ids: [member ids]} or {reset: true}',
            });
            return;
          }
          await writeSelection(next);
        }
      }
      sendJson(res, 200, {
        configured: true,
        health: life360.health(),
        ...chaserRoster(members, visibility()),
      });
    } catch (err) {
      console.warn('[life360] picker error:', err?.message || err);
      sendJson(res, 502, { configured: true, error: 'life360 picker failed' });
    }
  };

  const install = (server) => {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url || '/', 'http://local');
      if (PICKER_ROUTES.has(url.pathname)) {
        await handlePicker(req, res, url.pathname);
        return;
      }
      if (req.method !== 'GET' || !ROUTES.has(url.pathname)) return next();
      const life360 = getClient();
      if (url.pathname === '/chasers.txt') {
        let body;
        try {
          if (!life360) throw new Error('LIFE360_TOKEN not set');
          const members = await life360.getMembers();
          const lat = Number.parseFloat(url.searchParams.get('lat'));
          const lon = Number.parseFloat(url.searchParams.get('lon'));
          body = buildChaserPlacefile(chaserPositions(members, visibility()), {
            health: life360.health(),
            lat,
            lon,
          });
        } catch (err) {
          // A valid (empty) placefile keeps Supercell Wx from erroring out.
          const reason = String(err?.message || err).replace(/[\r\n"]/g, ' ');
          body = `Title: Chasers (error: ${reason})\nRefreshSeconds: 15\n`;
        }
        send(res, 200, 'text/plain; charset=utf-8', body);
        return;
      }
      if (!life360) {
        sendJson(res, 200, { configured: false, chasers: [] });
        return;
      }
      try {
        const members = await life360.getMembers();
        const health = life360.health();
        if (url.pathname === '/api/chasers/health') {
          sendJson(res, health.state === 'FAIL' ? 503 : 200, {
            status: health.state,
            detail: health.detail,
            chasers: members.length,
            seconds_since_ok: life360.secondsSinceOk(),
          });
          return;
        }
        const chasers = chaserPositions(members, visibility()).map(
          ({ id, name, lat, lon, fixMs, battery }) => ({
            id,
            name,
            lat,
            lon,
            fixMs,
            battery,
          }),
        );
        sendJson(res, 200, { configured: true, health, chasers });
      } catch (err) {
        console.warn('[life360] route error:', err?.message || err);
        sendJson(res, 502, {
          configured: true,
          error: 'life360 bridge failed',
        });
      }
    });
  };
  return {
    name: 'life360-chasers',
    configureServer: install,
    configurePreviewServer: install,
  };
}
