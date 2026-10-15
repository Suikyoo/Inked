import { describe, expect, it } from 'vitest';
import { CONNECT, isConnectMessage, isReadyMessage, isRenderRequest, isRenderResult } from './protocol';

describe('protocol guards', () => {
  it('accepts well-formed messages', () => {
    expect(isConnectMessage({ type: CONNECT, theme: { darkMode: true } })).toBe(true);
    expect(isReadyMessage({ type: 'ready' })).toBe(true);
    expect(isRenderRequest({ type: 'render', id: 'a', source: 'graph TD' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: '<svg/>', css: '' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'syntax' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'load', message: 'x' })).toBe(true);
  });

  it.each([null, undefined, 'ready', 5, [], {}])('rejects %j everywhere', (v) => {
    expect(isConnectMessage(v)).toBe(false);
    expect(isReadyMessage(v)).toBe(false);
    expect(isRenderRequest(v)).toBe(false);
    expect(isRenderResult(v)).toBe(false);
  });

  it('rejects wrong shapes', () => {
    expect(isConnectMessage({ type: CONNECT })).toBe(false);
    expect(isConnectMessage({ type: CONNECT, theme: 'dark' })).toBe(false);
    expect(isRenderRequest({ type: 'render', id: 1, source: 'x' })).toBe(false);
    expect(isRenderRequest({ type: 'render', id: 'a' })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: '<svg/>' })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: '<svg/>', css: 5 })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: 5 })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'timeout' })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 5 })).toBe(false);
    expect(isRenderResult({ type: 'result', ok: true, svg: '' })).toBe(false);
  });
});
