import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextControls } from './contextControls.js';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const radioBindings = read('./radioBindings.js');
const radioPresentation = read('./radioPresentation.js');
const radioControlsSource = read('./radioControls.js');

function radioToggle() {
  return radioBindings.slice(
    radioBindings.indexOf('const toggleRadio = async (trigger) => {'),
    radioBindings.indexOf("this.listen(this._radioFilter, 'change'"),
  );
}

test('the Radio chip catches lifecycle rejection and semantic false through the toast wrapper', () => {
  const radioControls = radioToggle();
  assert.match(radioControls, /await this\.actions\.runUserAction\(/);
  assert.match(radioControls, /Radio could not \$\{enabling \? 'start' : 'stop'\} cleanly/);
  assert.match(radioControls, /if \(this\.destroyed \|\| toggled === false\) return/);
});

test('only the expanded Radio Enable gesture requests the contained post-enable reveal', () => {
  const radioControls = radioToggle();
  assert.match(radioControls, /revealAfterEnable = enabling && trigger === this\._radioEnableBtn/);
  assert.match(radioControls, /if \(revealAfterEnable\)\s*await this\._revealRadioControlsAfterExplicitEnable\(trigger\)/);
  assert.equal((radioBindings.match(/_revealRadioControlsAfterExplicitEnable\(trigger\)/g) || []).length, 1);
  assert.match(radioControlsSource, /async _revealRadioControlsAfterExplicitEnable\(trigger\)/);
});

test('Radio and Clear All buttons remain focused while busy', () => {
  const radio = radioBindings.slice(radioBindings.indexOf('const toggleRadio = async (trigger) => {'), radioBindings.indexOf('this.listen(this._contextRadioToggleBtn,'));
  const radioSync = radioPresentation.slice(0, radioPresentation.indexOf('if (this._radioFilter)'));
  const clear = ContextControls.prototype.clearSelectedLayers.toString();
  assert.match(radio, /trigger\.getAttribute\('aria-busy'\) === 'true'/);
  assert.doesNotMatch(radio, /trigger\.disabled\s*=\s*true/);
  for (const name of ['_radioEnableBtn', '_contextRadioMiniEnableBtn', '_cockpitRadioEnableBtn']) {
    assert.match(radioSync, new RegExp(`${name}\\.disabled = false`));
  }
  assert.doesNotMatch(clear, /_clearSelectedLayersBtn\.disabled\s*=\s*true/);
  assert.match(clear, /this\.setClearBusy\(true\)/);
  const control = read('./clearLayersControl.js');
  assert.match(control, /button\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.doesNotMatch(control, /button\.disabled\s*=/);
});
