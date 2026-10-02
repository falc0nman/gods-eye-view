/**
 * PICK CHASERS — choose which Life360 circle members show, on the map AND in
 * the Supercell Wx placefile (the selection is saved on the server; see the
 * life360Chasers plugin in vite.config.js). Replaces the Python bridge's
 * start-up roster prompt.
 *
 * Saving with everyone ticked stores "everyone", so a chaser who joins the
 * circle later shows up without another visit here. Names come from Life360,
 * so every one of them is inserted as text, never markup.
 */

const ROSTER_URL = '/api/chasers/roster';
const SELECTION_URL = '/api/chasers/selection';

const MODE_TEXT = Object.freeze({
  everyone: 'Showing everyone in the circle.',
  allowlist: 'Showing the CHASER_ALLOWLIST names from .env.',
  picker: 'Showing your saved selection.',
});

/** What a save sends: everyone ticked → `[]` (everyone, including future joiners). */
export function selectionPayload(roster, checkedIds) {
  const checked = roster.filter((m) => checkedIds.has(m.id)).map((m) => m.id);
  if (checked.length === 0) return null;
  return { ids: checked.length === roster.length ? [] : checked };
}

/** Human message for a failed picker request. */
export function pickerErrorText(status, payload) {
  if (status === 403) return 'The picker only works on the machine running the server.';
  if (payload?.configured === false) return 'Add LIFE360_TOKEN to .env first.';
  return payload?.error || `Request failed (HTTP ${status}).`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{fetchImpl?: Function, onSaved?: Function}} [options]
 * @returns {{open: () => Promise<void>, close: () => void}}
 */
export function createTeamChaserPicker({ fetchImpl = (...args) => fetch(...args), onSaved = () => {} } = {}) {
  let root = null;
  let roster = [];
  let busy = false;

  const close = () => {
    root?.remove();
    root = null;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && root) {
      event.stopPropagation();
      close();
    }
  };

  const request = async (url, init) => {
    const response = await fetchImpl(url, { cache: 'no-store', ...init });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.configured === false) {
      throw new Error(pickerErrorText(response.status, payload));
    }
    return payload;
  };

  const build = () => {
    root = el('div', 'chaser-picker');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'chaser-picker-title');
    const title = el('h2', 'chaser-picker-title', 'PICK CHASERS');
    title.id = 'chaser-picker-title';
    root.append(
      title,
      el('p', 'chaser-picker-mode', 'Loading roster…'),
      el('div', 'chaser-picker-list'),
      el('p', 'chaser-picker-status'),
    );
    const actions = el('div', 'chaser-picker-actions');
    const button = (label, action, extra = '') => {
      const b = el('button', `chaser-picker-btn ${extra}`.trim(), label);
      b.type = 'button';
      b.dataset.action = action;
      actions.append(b);
      return b;
    };
    button('All', 'all');
    button('None', 'none');
    button('Use .env default', 'reset', 'chaser-picker-reset').hidden = true;
    button('Cancel', 'cancel');
    button('Save', 'save', 'chaser-picker-save');
    root.append(actions);
    actions.addEventListener('click', (event) => {
      const action = event.target?.closest?.('button')?.dataset.action;
      if (action) void act(action);
    });
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
  };

  const setStatus = (text) => {
    if (root) root.querySelector('.chaser-picker-status').textContent = text || '';
  };

  const render = (payload) => {
    roster = Array.isArray(payload.roster) ? payload.roster : [];
    root.querySelector('.chaser-picker-mode').textContent = MODE_TEXT[payload.mode] || '';
    root.querySelector('.chaser-picker-reset').hidden = payload.mode !== 'picker';
    const list = root.querySelector('.chaser-picker-list');
    list.replaceChildren();
    if (!roster.length) list.append(el('p', 'chaser-picker-empty', 'No one in the circle yet.'));
    for (const member of roster) {
      const row = el('label', 'chaser-picker-row');
      const box = el('input');
      box.type = 'checkbox';
      box.value = member.id;
      box.checked = Boolean(member.shown);
      row.append(box, el('span', 'chaser-picker-name', member.label));
      if (!member.hasFix) row.append(el('span', 'chaser-picker-nofix', 'no location'));
      list.append(row);
    }
    list.querySelector('input')?.focus();
  };

  const checkedIds = () => new Set(
    [...root.querySelectorAll('.chaser-picker-list input:checked')].map((box) => box.value),
  );

  const act = async (action) => {
    if (!root || busy) return;
    if (action === 'cancel') return close();
    if (action === 'all' || action === 'none') {
      for (const box of root.querySelectorAll('.chaser-picker-list input')) box.checked = action === 'all';
      return;
    }
    const body = action === 'reset' ? { reset: true } : selectionPayload(roster, checkedIds());
    if (!body) {
      setStatus('Pick at least one chaser, or Cancel.');
      return;
    }
    busy = true;
    setStatus('Saving…');
    try {
      await request(SELECTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      close();
      onSaved();
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  };

  return {
    async open() {
      if (root) return;
      build();
      try {
        render(await request(ROSTER_URL));
      } catch (error) {
        root.querySelector('.chaser-picker-mode').textContent = '';
        setStatus(error.message);
      }
    },
    close,
  };
}
