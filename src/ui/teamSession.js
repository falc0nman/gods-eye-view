/** Account controls use server-issued identity and permissions; never provider tokens. */
export async function initTeamSession({
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  enabled = import.meta.env?.PROD,
  signal,
} = {}) {
  const inert = { destroy() {} };
  if (!enabled || signal?.aborted) return inert;
  const host = documentRef?.getElementById('top-center-actions');
  if (!host) return inert;
  let response;
  try {
    response = await fetchImpl('/auth/providers', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return inert;
    response = await response.json();
  } catch {
    return inert;
  }
  if (
    signal?.aborted ||
    (!response.session && !response.discord && !response.google)
  )
    return inert;
  let control,
    disposed = false,
    account = response.session;
  function render() {
    control?.remove();
    if (disposed || signal?.aborted) return;
    control = documentRef.createElement(account ? 'button' : 'a');
    control.id = 'team-session';
    if (account) {
      control.type = 'button';
      control.textContent = `${account.callsign || account.displayName} · Sign out`;
      control.title = `Team roles: ${account.roles.join(', ')}`;
      control.addEventListener('click', async () => {
        control.disabled = true;
        try {
          const result = await fetchImpl('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-GEV-CSRF': account.csrfToken },
            signal,
          });
          if (!result.ok) throw new Error('logout failed');
          account = null;
          render();
        } catch {
          if (disposed || signal?.aborted) return;
          control.textContent = 'Sign out failed · Retry';
          control.disabled = false;
        }
      });
    } else {
      control.href = '/auth/login';
      control.textContent = 'Team sign in';
    }
    host.append(control);
  }
  function destroy() {
    disposed = true;
    control?.remove();
    signal?.removeEventListener('abort', destroy);
  }
  signal?.addEventListener('abort', destroy, { once: true });
  render();
  return { destroy };
}
