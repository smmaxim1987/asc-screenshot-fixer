'use strict';

const $ = (id) => document.getElementById(id);

/** The session id lives in the tab memory only — a reload requires the credentials again. */
let sessionId = null;
let apps = [];
const selected = new Set();

function show(node, kind, text) {
  node.className = `msg ${kind}`;
  node.textContent = text;
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Session expired or the server restarted — fall back to the credentials form.
    if (response.status === 401 || response.status === 404) {
      sessionId = null;
      resetToAuth(payload.error ?? 'Session expired, please re-enter your credentials');
    }
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }

  return payload;
}

function resetToAuth(message) {
  $('scan-section').classList.add('hidden');
  $('results-section').classList.add('hidden');
  $('action-bar').classList.remove('show');
  selected.clear();
  if (message) {
    show($('auth-msg'), 'error', message);
  }
}

function formatSize(bytes) {
  if (!bytes) {
    return '—';
  }
  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const STATE_LABELS = {
  AWAITING_UPLOAD: 'awaiting upload',
  UPLOAD_COMPLETE: 'uploaded',
  PROCESSING: 'processing',
  COMPLETE: 'ready',
  FAILED: 'processing failed',
  EXPIRED: 'expired',
  MISSING_UPLOAD: 'file never uploaded',
  UNKNOWN: 'unknown',
};

function renderStats(totals) {
  $('stats').innerHTML = [
    { value: totals.stuck, label: 'stuck', cls: 'stuck' },
    { value: totals.processing, label: 'processing', cls: 'processing' },
    { value: totals.ok, label: 'ready', cls: 'ok' },
    { value: totals.screenshots, label: 'total', cls: '' },
  ]
    .map(
      (s) =>
        `<div class="stat"><b class="badge ${s.cls}">${s.value}</b><span>${s.label}</span></div>`,
    )
    .join('');
}

function updateBar() {
  $('selected-count').textContent = String(selected.size);
  $('action-bar').classList.toggle('show', selected.size > 0);
}

function renderSets(scan) {
  const container = $('sets');

  if (scan.totals.screenshots === 0) {
    container.innerHTML = '<div class="empty">No screenshots found</div>';
    return;
  }

  container.innerHTML = scan.sets
    .map((set) => {
      const rows = set.screenshots
        .map((shot) => {
          const disabled = shot.verdict === 'ok' ? ' disabled' : '';
          const checked = selected.has(shot.id) ? ' checked' : '';
          return `
        <div class="shot">
          <input type="checkbox" class="shot-check" data-id="${shot.id}"${checked}${disabled}>
          ${shot.imageUrl ? `<img class="thumb" src="${shot.imageUrl}" alt="">` : '<div class="thumb"></div>'}
          <div class="info">
            <div class="name">${shot.fileName ?? '(no filename)'}</div>
            <div class="sub">${formatSize(shot.fileSize)} · ${shot.uploadedAt ? new Date(shot.uploadedAt).toLocaleString('en-US') : 'date unknown'}</div>
            ${shot.errorMessage ? `<div class="sub" style="color:var(--danger)">${shot.errorMessage}</div>` : ''}
          </div>
          <span class="badge ${shot.verdict}">${STATE_LABELS[shot.assetDeliveryState] ?? shot.assetDeliveryState}</span>
          ${shot.verdict !== 'ok' ? `<button class="shot-del" data-id="${shot.id}">Delete</button>` : ''}
        </div>`;
        })
        .join('');

      const title = `${set.screenshotDisplayType} · ${set.locale ?? 'unknown locale'}`;

      return `
    <div class="set">
      <div class="set-head">
        <h3>${title}</h3>
        <span class="meta">${set.screenshots.length} items · <code>${set.id.slice(0, 8)}</code></span>
      </div>
      ${rows || '<div class="empty">Empty</div>'}
    </div>`;
    })
    .join('');

  container.querySelectorAll('.shot-check').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) {
        selected.add(box.dataset.id);
      } else {
        selected.delete(box.dataset.id);
      }
      updateBar();
    });
  });

  container.querySelectorAll('.shot-del').forEach((button) => {
    button.addEventListener('click', () => deleteScreenshots([button.dataset.id]));
  });
}

async function deleteScreenshots(ids) {
  if (ids.length === 0) {
    return;
  }

  const confirmed = window.confirm(
    `Delete ${ids.length} screenshot(s)?\n\n` +
      'No backup of the files is made — after deleting you will have to upload them again.',
  );
  if (!confirmed) {
    return;
  }

  $('scan-msg').textContent = '';
  show($('scan-msg'), 'info', `Deleting ${ids.length}…`);

  try {
    const report = await api('POST', '/api/screenshots/delete', { ids });
    const failed = report.results.filter((r) => !r.ok);

    if (failed.length === 0) {
      show($('scan-msg'), 'ok', `Deleted: ${report.deleted}`);
    } else {
      show($('scan-msg'), 'error', `Deleted ${report.deleted}, failed ${failed.length}: ${failed[0].error}`);
    }

    ids.forEach((id) => selected.delete(id));
    updateBar();
    await scan();
  } catch (error) {
    show($('scan-msg'), 'error', error.message);
  }
}

async function scan() {
  const appId = $('app-select').value;
  if (!appId) {
    return;
  }

  $('scan').disabled = true;
  show($('scan-msg'), 'info', 'Scanning screenshots, this can take up to a minute…');

  try {
    const result = await api('GET', `/api/scan?appId=${encodeURIComponent(appId)}`);
    selected.clear();
    updateBar();
    renderStats(result.totals);
    renderSets(result);
    $('results-section').classList.remove('hidden');
    show(
      $('scan-msg'),
      result.totals.stuck > 0 ? 'error' : 'ok',
      result.totals.stuck > 0
        ? `Stuck screenshots found: ${result.totals.stuck}. They can be deleted.`
        : 'No stuck screenshots found.',
    );
  } catch (error) {
    show($('scan-msg'), 'error', error.message);
  } finally {
    $('scan').disabled = false;
  }
}

function fillApps(list, selectedApp) {
  apps = list;
  $('app-select').innerHTML = list
    .map((app) => `<option value="${app.id}">${app.name} — ${app.bundleId}</option>`)
    .join('');

  if (selectedApp) {
    $('app-select').value = selectedApp.id;
  }
  $('scan-section').classList.remove('hidden');
}

/**
 * Reads the .p8 in the browser and, for a file named like AuthKey_2X9R4HXF34.p8,
 * fills in the Key ID automatically — it is the value people hunt for longest.
 */
$('pick-file').addEventListener('click', () => $('keyFile').click());

$('keyFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    $('privateKey').value = text.trim();

    const fromName = /AuthKey_([A-Z0-9]{10})\.p8$/i.exec(file.name);
    if (fromName && !$('keyId').value.trim()) {
      $('keyId').value = fromName[1];
    }

    $('file-name').textContent = `Read: ${file.name} (${text.trim().length} characters)`;
    show($('auth-msg'), 'ok', 'Key loaded. Check the Issuer ID and press "Connect".');
  } catch (error) {
    show($('auth-msg'), 'error', `Could not read the file: ${error.message}`);
  }
});

/** Builds the request payload — shared by connect and diagnostics. */
function readCredentials() {
  return {
    issuerId: $('issuerId').value.trim(),
    keyId: $('keyId').value.trim(),
    privateKey: $('privateKey').value.trim(),
    keyKind: $('keyKind').value,
  };
}

/** Explains where to find the data for the selected key type. */
const KEY_KIND_HINTS = {
  team: 'Users and Access → Integrations → App Store Connect API → Team Keys tab. Grants access to every app in the team.',
  individual:
    'Users and Access → People → your profile → Individual API Key. Access is limited to the apps and permissions of your user.',
};

$('keyKind').addEventListener('change', (event) => {
  $('keyKind-hint').textContent = KEY_KIND_HINTS[event.target.value] ?? '';
});

$('keyKind-hint').textContent = KEY_KIND_HINTS.team;

/** Renders the diagnostics report: what passed, what failed and what to do. */
function renderDiagnostics(report) {
  const rows = report.checks
    .map(
      (check) => `
    <div class="check ${check.ok ? 'pass' : 'fail'}">
      <span class="mark">${check.ok ? '✓' : '✕'}</span>
      <div>
        <b>${check.label}</b>
        <div class="hint">${check.detail}</div>
      </div>
    </div>`,
    )
    .join('');

  const hints = report.hints.length
    ? `<ul class="hints">${report.hints.map((hint) => `<li>${hint}</li>`).join('')}</ul>`
    : '';

  const token = report.header && report.payload
    ? `<details class="token">
         <summary>What is sent to Apple (JWT)</summary>
         <pre>header  ${JSON.stringify(report.header, null, 2)}

payload ${JSON.stringify(report.payload, null, 2)}

key     ${report.publicKeyPreview ?? '—'}</pre>
       </details>`
    : '';

  $('diag-report').innerHTML = rows + hints + token;
  $('diag-report').classList.remove('hidden');
}

$('diagnose').addEventListener('click', async () => {
  const button = $('diagnose');
  button.disabled = true;
  $('diag-msg').textContent = '';

  try {
    const report = await api('POST', '/api/diagnose', readCredentials());
    renderDiagnostics(report);

    if (report.accepted) {
      show($('diag-msg'), 'ok', 'The key works — you can press "Connect".');
    } else {
      show($('diag-msg'), 'error', 'Check the item marked ✕ below.');
    }

    // If the key worked with another type, switch it and let the user re-check.
    if (report.suggestedKeyKind) {
      $('keyKind').value = report.suggestedKeyKind;
      $('keyKind-hint').textContent =
        KEY_KIND_HINTS[report.suggestedKeyKind] + ' · set automatically';
      show(
        $('diag-msg'),
        'info',
        'The key type was detected automatically and set in the form. Press "Connect".',
      );
    }
  } catch (error) {
    show($('diag-msg'), 'error', error.message);
  } finally {
    button.disabled = false;
  }
});

$('connect').addEventListener('click', async () => {
  const button = $('connect');
  button.disabled = true;
  $('auth-msg').textContent = '';

  try {
    const result = await api('POST', '/api/session', {
      ...readCredentials(),
      bundleId: $('bundleId').value.trim() || undefined,
    });

    sessionId = result.sessionId;
    fillApps(result.apps, result.selectedApp);
    $('diag-report').classList.add('hidden');
    $('diag-msg').textContent = '';
    show($('auth-msg'), 'ok', 'Credentials accepted, connected to App Store Connect.');
    // The private key is no longer needed in the DOM — clear the field.
    $('privateKey').value = '';
    await scan();
  } catch (error) {
    show($('auth-msg'), 'error', error.message);
  } finally {
    button.disabled = false;
  }
});

$('scan').addEventListener('click', scan);
$('rescan').addEventListener('click', scan);

$('select-all-stuck').addEventListener('change', (event) => {
  const checkAll = event.target.checked;
  document.querySelectorAll('.shot-check').forEach((box) => {
    if (box.disabled) {
      return;
    }
    box.checked = checkAll;
    if (checkAll) {
      selected.add(box.dataset.id);
    } else {
      selected.delete(box.dataset.id);
    }
  });
  updateBar();
});

$('delete').addEventListener('click', () => deleteScreenshots([...selected]));

$('logout').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/session');
  } catch {
    // The session may already be gone — not critical.
  }
  sessionId = null;
  $('keyFile').value = '';
  $('file-name').textContent = '';
  resetToAuth('Disconnected. The keys were removed from server memory.');
});