import test from 'node:test';
import assert from 'node:assert/strict';
import { getAlertLevel, isRelevantForPush, referencedIdentifiers, currentCapAlerts, parseCap } from './worker.js';

const NOW = Date.parse('2026-11-15T15:00:00Z');
const base = {
  identifier: 'smn-alert-1', status: 'Actual', msgType: 'Alert', scope: 'Public',
  affectsLocation: true, effective: '2026-11-15T14:00:00Z',
  expires: '2026-11-15T18:00:00Z', urgency: 'Expected',
  certainty: 'Likely', severity: 'Severe', headline: 'Tormentas fuertes',
};

test('CAP Severe sin color SAT explícito queda desconocido y no genera Push', () => {
  assert.equal(getAlertLevel(base), 'desconocido');
  assert.equal(isRelevantForPush(base, NOW), false);
});
test('un parámetro CAP explícito fija el color naranja y habilita Push', () => {
  const alert = { ...base, parameters: [{ name: 'SAT_COLOR', value: 'Naranja' }] };
  assert.equal(getAlertLevel(alert), 'naranja');
  assert.equal(isRelevantForPush(alert, NOW), true);
});
test('un parámetro CAP explícito amarillo prevalece sobre CAP Severe', () => {
  const alert = { ...base, parameters: [{ name: 'SAT_NIVEL', value: 'Amarillo' }] };
  assert.equal(getAlertLevel(alert), 'amarillo');
  assert.equal(isRelevantForPush(alert, NOW), false);
});
test('CAP Extreme sin color SAT explícito queda desconocido', () => {
  const alert = { ...base, severity: 'Extreme' };
  assert.equal(getAlertLevel(alert), 'desconocido');
  assert.equal(isRelevantForPush(alert, NOW), false);
});
test('un nivel rojo explícito en el texto oficial permite Push', () => {
  const alert = { ...base, headline: 'Alerta roja por tormentas' };
  assert.equal(getAlertLevel(alert), 'rojo');
  assert.equal(isRelevantForPush(alert, NOW), true);
});
test('el color amarillo explícito prevalece y no genera Push', () => {
  const alert = { ...base, headline: 'Alerta amarilla por tormentas' };
  assert.equal(getAlertLevel(alert), 'amarillo');
  assert.equal(isRelevantForPush(alert, NOW), false);
});
test('CAP Moderate sin color SAT explícito queda desconocido y no genera Push', () => {
  const alert = { ...base, severity: 'Moderate' };
  assert.equal(getAlertLevel(alert), 'desconocido');
  assert.equal(isRelevantForPush(alert, NOW), false);
});
test('no envía avisos fuera de la ubicación', () => {
  assert.equal(isRelevantForPush({ ...base, affectsLocation: false }, NOW), false);
});
test('no envía avisos vencidos o todavía no efectivos', () => {
  assert.equal(isRelevantForPush({ ...base, expires: '2026-11-15T14:59:00Z' }, NOW), false);
  assert.equal(isRelevantForPush({ ...base, effective: '2026-11-15T15:01:00Z' }, NOW), false);
});
test('no envía avisos con certeza posible ni urgencia futura', () => {
  assert.equal(isRelevantForPush({ ...base, certainty: 'Possible' }, NOW), false);
  assert.equal(isRelevantForPush({ ...base, urgency: 'Future' }, NOW), false);
});
test('extrae identificadores de referencias CAP', () => {
  assert.deepEqual(
    referencedIdentifiers('smn.gov.ar,alerta-antigua,2026-11-15T13:00:00Z smn.gov.ar,otra-alerta,2026-11-15T13:10:00Z'),
    ['alerta-antigua', 'otra-alerta']
  );
});

test('parsea un documento CAP XML y conserva parámetros SAT explícitos', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
    <identifier>smn-test-001</identifier><sender>smn.gob.ar</sender>
    <sent>2026-11-16T10:00:00-03:00</sent><status>Actual</status>
    <msgType>Alert</msgType><scope>Public</scope>
    <info><event>Tormentas</event><headline>Alerta naranja por tormentas</headline>
      <description>Tormentas fuertes.</description><severity>Severe</severity>
      <urgency>Immediate</urgency><certainty>Likely</certainty>
      <effective>2026-11-16T10:00:00-03:00</effective>
      <expires>2026-11-16T14:00:00-03:00</expires>
      <parameter><valueName>SAT_COLOR</valueName><value>Naranja</value></parameter>
      <area><areaDesc>Córdoba</areaDesc><circle>-31.42,-64.18 25</circle></area>
    </info>
  </alert>`;
  const [alert] = parseCap(xml, -31.42, -64.18);
  assert.equal(alert.identifier, 'smn-test-001');
  assert.equal(alert.status, 'Actual');
  assert.equal(alert.msgType, 'Alert');
  assert.equal(alert.parameters[0].name, 'SAT_COLOR');
  assert.equal(alert.parameters[0].value, 'Naranja');
  assert.equal(alert.affectsLocation, true);
  assert.equal(getAlertLevel(alert), 'naranja');
  assert.equal(isRelevantForPush(alert, Date.parse('2026-11-16T11:00:00-03:00')), true, JSON.stringify(alert));
});

test('no envía Push hasta la fecha más tardía entre effective y onset', () => {
  const alert = {
    ...base,
    effective: '2026-11-15T14:00:00Z',
    onset: '2026-11-15T15:30:00Z',
    parameters: [{ name: 'SAT_COLOR', value: 'Naranja' }],
  };
  assert.equal(isRelevantForPush(alert, Date.parse('2026-11-15T15:00:00Z')), false);
  assert.equal(isRelevantForPush(alert, Date.parse('2026-11-15T15:30:00Z')), true);
});
test('no envía Push si CAP no informa vencimiento verificable', () => {
  const { expires, ...withoutExpiry } = base;
  assert.equal(isRelevantForPush(withoutExpiry, NOW), false);
});

test('CAP Update supersedes the referenced previous alert before Push selection', () => {
  const previous = { ...base, identifier: 'old-alert', msgType: 'Alert' };
  const update = {
    ...base,
    identifier: 'updated-alert',
    msgType: 'Update',
    references: 'smn.gob.ar,old-alert,2026-11-15T13:00:00Z',
  };
  const current = currentCapAlerts([previous, update], NOW);
  assert.deepEqual(current.map(alert => alert.identifier), ['updated-alert']);
});
test('CAP Cancel removes the referenced alert from the active set', () => {
  const previous = { ...base, identifier: 'old-alert', msgType: 'Alert' };
  const cancel = {
    identifier: 'cancel-alert',
    status: 'Actual',
    msgType: 'Cancel',
    scope: 'Public',
    references: 'smn.gob.ar,old-alert,2026-11-15T13:00:00Z',
  };
  assert.deepEqual(currentCapAlerts([previous, cancel], NOW), []);
});
