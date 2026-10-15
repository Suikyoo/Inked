// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CONNECT } from '../diagrams/protocol';
import { createConnectListener } from './handshake';

const parent = {} as Window;
const stranger = {} as Window;
const port = {} as MessagePort;
const theme = { darkMode: true };

const event = (source: unknown, data: unknown, ports: unknown[]) => ({ source, data, ports }) as unknown as MessageEvent;
const valid = () => event(parent, { type: CONNECT, theme }, [port]);

function make() {
  const onConnected = vi.fn();
  return { onConnected, listener: createConnectListener({ parent, onConnected }) };
}

describe('createConnectListener', () => {
  it('ignores a message from anyone but the parent', () => {
    const { listener, onConnected } = make();
    listener(event(stranger, { type: CONNECT, theme }, [port]));
    listener(event(null, { type: CONNECT, theme }, [port]));
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('ignores a message with a bad shape', () => {
    const { listener, onConnected } = make();
    listener(event(parent, { type: 'other', theme }, [port]));
    listener(event(parent, { type: CONNECT }, [port]));
    listener(event(parent, 'connect', [port]));
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('ignores a message with zero or two ports', () => {
    const { listener, onConnected } = make();
    listener(event(parent, { type: CONNECT, theme }, []));
    listener(event(parent, { type: CONNECT, theme }, [port, {} as MessagePort]));
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('connects once with the port and theme, and ignores a second valid message', () => {
    const { listener, onConnected } = make();
    listener(valid());
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith(port, theme);
    listener(valid());
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('does not accept a second connect even if onConnected throws', () => {
    const onConnected = vi.fn(() => {
      throw new Error('boom');
    });
    const listener = createConnectListener({ parent, onConnected });
    expect(() => listener(valid())).toThrow('boom');
    listener(valid());
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
