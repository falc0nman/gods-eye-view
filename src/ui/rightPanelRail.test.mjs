import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldHideCollapsedRightPanels } from './panelRailGeometry.js';

test('Tactical HUD hides collapsed right-rail siblings while one panel is expanded', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'tactical',
    hasExpandedPanel: true,
  }), true);
});

test('collapsed launchers remain when Tactical has no expanded panel', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'tactical',
    hasExpandedPanel: false,
  }), false);
});

test('other HUD layouts keep collapsed right-rail launchers visible', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'minimal',
    hasExpandedPanel: true,
  }), false);
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'full',
    hasExpandedPanel: true,
  }), false);
});

test('desktop Display participates in Tactical exclusivity without changing mobile Display behavior', () => {
  const ui = readFileSync(new URL('./rightPanelRail.js', import.meta.url), 'utf8');
  const css = readStylesheet(new URL('../../style.css', import.meta.url));
  assert.match(ui, /const isMobile = windowRef\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
  assert.match(
    ui,
    /!panel\.classList\.contains\('collapsed'\)\s*&&\s*\(!isMobile \|\| panel\.id !== 'pp-toggles'\)/,
  );
  assert.doesNotMatch(
    ui,
    /panel\.id !== 'pp-toggles' && !panel\.classList\.contains\('collapsed'\)/,
  );
  assert.match(ui, /if \(exclusive && panel\.classList\.contains\('collapsed'\)\)\s*panel\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(css, /#right-context-rail\.layout-exclusive > \[data-panel-id\]\.collapsed \{/);
});
