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

test('CAP Severe se clasifica Naranja y puede generar Push', () => {
  assert.equal(getAlertLevel(base), 'naranja');
  assert.equal(isRelevantForPush(base, NOW), true);
});
test('CAP Extreme se clasifica Rojo y puede generar Push', () => {
  const alert = { ...base, severity: 'Extreme' };
  assert.equal(getAlertLevel(alert), 'rojo');
  assert.equal(isRelevantForPush(alert, NOW), true);
});
test('el color amarillo explícito prevalece y no genera Push', () => {
  const alert = { ...base, headline: 'Alerta amarilla por tormentas' };
  assert.equal(getAlertLevel(alert), 'amarillo');
  assert.equal(isRelevantForPush(alert, NOW), false);
});
test('CAP Moderate queda amarillo y no genera Push', () => {
  const alert = { ...base, severity: 'Moderate' };
  assert.equal(getAlertLevel(alert), 'amarillo');
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
