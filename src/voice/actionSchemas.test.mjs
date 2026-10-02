import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, stable(child)]),
        )
      : value;

test('the complete Realtime tool payload pins the additive analyst, satellite, Local ADS-B and Cyber release', () => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        stable(
          GEV_REALTIME_TOOLS.filter((tool) => tool.name !== 'set_cyber_sonar'),
        ),
      ),
    )
    .digest('hex');
  assert.equal(
    digest,
    // Re-derived for the additive `local-adsb` set_layer_visibility value and
    // the Cyber HUD layout; the separate sonar tool is excluded above.
    // Re-derived again for the storm-chase layer ids (weather-radar, nexrad, nws-warnings,
    // team-chasers) and their common-name mapping.
    // Re-derived for GW-57: telegeography-submarine-cables, alpr-cameras,
    // earthquakes, local-firms and fire-perimeters leave the layer enums,
    // mappings and analyst fields.
    '4b7ee6385cb1370da82ccf024a127ac1fd0f2d53f9cfa203575255fbce9ba63e',
  );
});

test('descriptions customize wording without changing immutable shared arguments', () => {
  const descriptions = {
    fly_to_location: {
      description: 'Navigate',
      parameters: { properties: { query: { description: 'A place' } } },
    },
  };
  const tools = createActionTools(descriptions);
  const tool = tools.find((tool) => tool.name === 'fly_to_location');
  assert.equal(tool.description, 'Navigate');
  assert.equal(tool.parameters.properties.query.description, 'A place');
  assert.equal(tool.parameters.properties.query.type, 'string');
  tool.parameters.properties.query.type = 'number';
  assert.equal(
    createActionTools()[0].parameters.properties.query.type,
    'string',
  );
  assert.throws(() => {
    GEV_ACTION_SCHEMAS[0].parameters.properties.query.type = 'number';
  }, TypeError);
  assert.equal(
    JSON.stringify(GEV_ACTION_SCHEMAS).includes('"description"'),
    false,
  );
});

test('metadata cannot add tools, fields, types or enum values', () => {
  for (const descriptions of [
    { execute_shell: { description: 'not an action' } },
    {
      fly_to_location: {
        parameters: { properties: { description: 'new field' } },
      },
    },
    { fly_to_location: { $position: -1, description: 'invalid position' } },
    { fly_to_location: { name: 'other' } },
    {
      fly_to_location: {
        parameters: { properties: { arbitrary: { description: 'new field' } } },
      },
    },
    {
      fly_to_location: {
        parameters: { properties: { query: { type: 'number' } } },
      },
    },
    { fly_to_location: { parameters: { required: { 0: 'another' } } } },
    { fly_to_location: { description: { nested: 'invalid' } } },
  ])
    assert.throws(() => createActionTools(descriptions), TypeError);
});

test('all legacy action arguments are byte-identical after removing the deliberate additions', () => {
  const legacy = structuredClone(GEV_ACTION_SCHEMAS).filter(
    (tool) => !['next_satellite_pass', 'set_cyber_sonar'].includes(tool.name),
  );
  const layers = legacy.find((tool) => tool.name === 'analyst_query').parameters
    .properties.layers.items;
  layers.enum = layers.enum.filter(
    (key) =>
      ![
        'satellites',
        'local-datacenters',
        'local-dams',
        'fire-perimeters',
      ].includes(key),
  );
  // Local ADS-B is an additive set_layer_visibility enum value.
  const visibility = legacy.find((tool) => tool.name === 'set_layer_visibility')
    .parameters.properties.layerId;
  visibility.enum = visibility.enum.filter(
    (key) => !['local-adsb', 'fire-perimeters'].includes(key),
  );
  // Storm chase adds three layer ids to both layer enums.
  const stormChase = [
    'weather-radar',
    'nexrad',
    'nws-warnings',
    'team-chasers',
  ];
  for (const tool of legacy) {
    for (const value of Object.values(tool.parameters.properties)) {
      if (value.enum)
        value.enum = value.enum.filter(
          (key) => key !== 'fire-perimeters' && !stormChase.includes(key),
        );
    }
  }
  // Independently derived by executing trusted c9f9896 actionSchemas in the restricted container.
  // Re-derived for GW-57, which removes telegeography-submarine-cables,
  // alpr-cameras, earthquakes, local-firms and fire-perimeters from the layer
  // enums: identical to main's schemas with only those values stripped.
  const hud = legacy.find((tool) => tool.name === 'set_hud').parameters
    .properties.layout;
  hud.enum = hud.enum.filter((layout) => layout !== 'cyber');
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    '3342b735ed3a00ab51306e6b3745410a0d9cfadeef084ae92ea05bb43c60c546',
  );
});
