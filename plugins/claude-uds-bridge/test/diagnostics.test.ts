import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { diagnoseConnection } from '../src/diagnostics';

test('diagnostics report the initialization phase before the outer hook deadline', async () => {
  const root = mkdtempSync('/tmp/uds-blackhole-');
  mkdirSync(join(root, 'ipc'), { mode: 0o700 });
  const path = join(root, 'ipc/ipc.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(path);
  await once(server, 'listening');
  chmodSync(path, 0o600);
  const start = Date.now();
  try {
    const result = await diagnoseConnection(path, randomUUID(), { kind: 'desktop', path });
    expect(result).toMatchObject({ reachable: false, error: { message: expect.stringContaining('Desktop initialize timed out') },
      advice: expect.stringContaining('IDE owns the router') });
    expect(Date.now() - start).toBeLessThan(5000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
}, 6000);
