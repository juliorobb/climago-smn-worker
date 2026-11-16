import test from 'node:test';
import assert from 'node:assert/strict';
import { getAlertLevel, isRelevantForPush, referencedIdentifiers } from './worker.js';

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
