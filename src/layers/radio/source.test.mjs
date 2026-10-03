import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadioSource, createRadioLayer } from './index.js';

const id = '00000000-0000-4000-8000-000000000001';

test('the stub radio source never fetches and reports an unconfigured directory', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('the stub must not fetch');
  });
  const source = createRadioSource();
  await assert.rejects(
    source.getDirectory(),
    /No radio directory is configured/,
  );
  await source.recordClick(id);
  for (const invalid of [
    '../stations',
    'https://example.com',
    '',
    null,
    `${id}?x=1`,
  ])
    await assert.rejects(
      source.recordClick(invalid),
      /Invalid radio station id/,
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getDirectory({ signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('radio factories keep settings and subscriptions independent without fetching or audio startup', () => {
  let requested = false;
  const source = {
    getDirectory() {
      requested = true;
    },
    recordClick() {
      requested = true;
    },
  };
  const services = {
    ground: {},
    picking: { unregisterPickOwner() {} },
    globe: {},
    render: { governorRequestRender() {} },
    overlays: {
      clearOverlaySource() {},
      setOverlaySourceVisible() {},
      setOverlayEntries() {},
    },
  };
  const first = createRadioLayer({ source, services });
  const second = createRadioLayer({ source, services });
  let changes = 0;
  const off = second.subscribeToRadio(() => changes++);
  const initialChanges = changes;
  first.setRadioParams({ volume: 0.3 });
  assert.equal(first.getRadioParams().volume, 0.3);
  assert.equal(second.getRadioParams().volume, 0.8);
  assert.equal(changes, initialChanges);
  assert.equal(requested, false);
  off();
  first.destroy();
  assert.equal(second.getRadioParams().volume, 0.8);
  second.destroy();
});
