import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const requestSchema = z.object({ type: z.string(), requestId: z.string().optional(), method: z.string(), params: z.unknown(), version: z.number().optional() });

type Patch = { op: string; path: (string | number)[]; value: unknown };
type DesktopState = 'idle' | 'active' | 'systemError';

export async function receiver(state: DesktopState, dropAcknowledgement = false, endBeforeSteer = false, root = mkdtempSync('/tmp/desktop-test-'), streamVersion = 11) {
  mkdirSync(join(root, 'ipc'), { mode: 0o700 });
  const path = join(root, 'ipc', 'ipc.sock');
  const threadId = randomUUID();
  const turnId = randomUUID();
  const compactions: string[] = [];
  let compactFailure: boolean = false;
  const submissions: { method: string; params: unknown }[] = [];
  const requests: z.infer<typeof requestSchema>[] = [];
  const queuedMessages = new Map<string, Record<string, unknown>>();
  let queueFailure: 'finalize' | 'ack' | undefined;
  let permissions: unknown = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
  let history: Record<string, unknown> = { turns: [], turnHistory: { kind: 'legacy' } };
  const clients = new Set<net.Socket>();
  const announce = new Set<(patches?: Patch[]) => void>();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const write = (packet: unknown) => {
      const body = Buffer.from(JSON.stringify(packet));
      const framed = Buffer.alloc(4 + body.length);
      framed.writeUInt32LE(body.length);
      body.copy(framed, 4);
      socket.write(framed);
    };
    const broadcast = (patches: Patch[] = [
      { op: 'replace', path: ['threadRuntimeStatus'], value: { type: state } },
      { op: 'replace', path: ['currentPermissions'], value: permissions },
    ]) => write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: streamVersion,
      params: { conversationId: threadId, change: { type: 'patches', patches } } });
    announce.add(broadcast);
    socket.on('close', () => announce.delete(broadcast));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE();
        const request = requestSchema.parse(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
        requests.push(request);
        buffer = buffer.subarray(4 + size);
        const reply = (result: unknown) => write({ type: 'response', requestId: request.requestId,
          handledByClientId: 'owner', resultType: 'success', result });
        if (request.method === 'initialize') reply({ clientId: 'test-client' });
        else if (request.method === 'thread-owner-discovery') reply({ supportsUntrustedAppInput: true });
        else if (request.method === 'thread-stream-following-changed') {
          if (!z.object({ following: z.boolean() }).parse(request.params).following) continue;
          write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: streamVersion,
            params: { conversationId: threadId, change: { type: 'snapshot',
              conversationState: { cwd: root, threadRuntimeStatus: { type: state }, currentPermissions: permissions, ...history } } } });
        } else if (request.method === 'thread-follower-compact-thread') {
          if (request.version !== 1) throw new Error('Wrong compact method version');
          const { conversationId } = z.object({ conversationId: z.string() }).parse(request.params);
          if (conversationId !== threadId) throw new Error('Wrong compact thread');
          const id = randomUUID();
          compactions.push(id);
          const turns = (history.turns ?? []) as { items: unknown[] }[];
          history.turns = [...turns, { turnId: randomUUID(), status: 'inProgress', items: [{ type: 'contextCompaction', id, completed: false, source: 'manual' }] }];
          state = 'active';
          if (compactFailure) socket.destroy();
          else reply({ ok: true });
        } else if (request.method === 'thread-follower-set-queued-follow-ups-state') {
          const params = z.object({ conversationId: z.string(), preparationMessageId: z.string(),
            state: z.record(z.string(), z.array(z.object({ id: z.string(), preparation: z.unknown().optional() }).passthrough())),
            discardedMessageIds: z.array(z.string()) }).parse(request.params);
          const message = params.state[threadId]?.[0];
          if (request.version !== 3 || streamVersion !== 13 || params.conversationId !== threadId || !message || message.id !== params.preparationMessageId) {
            write({ type: 'response', requestId: request.requestId, resultType: 'error', error: 'Invalid queue request' });
          } else if (message.preparation !== undefined) {
            if (!queuedMessages.has(message.id)) queuedMessages.set(message.id, message);
            reply({ ok: true });
          } else if (!queuedMessages.has(message.id) || queueFailure === 'finalize') {
            write({ type: 'response', requestId: request.requestId, resultType: 'error', error: 'Queued message preparation was canceled' });
          } else {
            queuedMessages.set(message.id, message);
            if (queueFailure === 'ack') socket.destroy();
            else reply({ ok: true });
          }
        } else if (request.method === 'thread-follower-remove-queued-message') {
          const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
          const message = queuedMessages.get(messageId);
          queuedMessages.delete(messageId);
          reply({ removed: message ? { message } : null });
        } else {
          if (request.method === 'thread-follower-steer-turn' && endBeforeSteer) {
            state = 'idle';
            write({ type: 'response', requestId: request.requestId, resultType: 'error',
              error: `Cannot steer conversation ${threadId} because its active turn already ended` });
            continue;
          }
          submissions.push({ method: request.method, params: request.params });
          if (dropAcknowledgement) socket.destroy();
          else reply({ result: state === 'active' ? { turnId } : { turn: { id: turnId } } });
        }
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  chmodSync(path, 0o600);
  return { path, threadId, turnId, submissions, requests, queuedMessages, compactions,
    loseAcknowledgement() { dropAcknowledgement = true; },
    loseCompactAcknowledgement() { compactFailure = true; },
    completeCompaction() {
      for (const turn of (history.turns ?? []) as { status?: string; items: { type: string; completed?: boolean }[] }[]) {
        if (turn.items.some(item => item.type === 'contextCompaction')) {
          turn.status = 'completed';
          for (const item of turn.items) if (item.type === 'contextCompaction') item.completed = true;
        }
      }
      state = 'idle';
      for (const send of announce) send();
    },
    failQueue(value: 'finalize' | 'ack') { queueFailure = value; },
    disconnectClients() { for (const socket of clients) socket.destroy(); },
    setHistory(value: Record<string, unknown>, patchPath?: (string | number)[]) {
      history = { turns: [], turnHistory: { kind: 'legacy' }, ...value };
      if (patchPath) for (const send of announce) send([{ op: 'replace', path: patchPath, value: null }]);
    },
    setPermissions(value: unknown) { permissions = value; for (const send of announce) send(); },
    setState(value: DesktopState) { state = value; for (const send of announce) send(); }, close: async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true });
  } };
}
