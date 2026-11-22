// Meet sirve las reuniones tanto en "/abc-defg-hij" como en "/meet/abc-defg-hij".
// Con la segunda ruta el panel no se montaba porque el código no se reconocía.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeetingCode, isInsideMeetingCall } from '../src/utils/meetContext.js';

test('reconoce el código con y sin el prefijo /meet/', () => {
  assert.equal(getMeetingCode('/xcb-fegf-upe'), 'xcb-fegf-upe');
  assert.equal(getMeetingCode('/meet/xcb-fegf-upe'), 'xcb-fegf-upe');
  assert.equal(getMeetingCode('/meet/xcb-fegf-upe/'), 'xcb-fegf-upe');
  assert.equal(getMeetingCode('/MEET/XCB-FEGF-UPE'), 'xcb-fegf-upe');
});

test('las rutas que no son una reunión siguen quedando afuera', () => {
  for (const ruta of ['/', '/landing', '/meet', '/meet/', '/meet/landing', '/otra/xcb-fegf-upe', '/meet/meet/xcb-fegf-upe']) {
    assert.equal(getMeetingCode(ruta), null, ruta);
    assert.equal(isInsideMeetingCall(ruta), false, ruta);
  }
});
