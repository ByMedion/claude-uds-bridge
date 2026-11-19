import { z } from 'zod';
import { uuid } from './claude';
import { desktopTurnEntries } from './turn-failure';

export type ReplyBlocked = { turnId: string; recipientId: string; deniedAtMs: number };
export type ReplyBlockedHandler = (event: ReplyBlocked) => void;
export type AppServerReplyObserver = (method: string, params: unknown) => void;

const terminal = z.enum(['completed', 'failed', 'interrupted']);
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const tool = z.object({ server: z.literal('claude_uds_bridge'), toolName: z.literal('send_message'),
  type: z.literal('mcpToolCall') });
const failedSend = z.object({ type: z.literal('mcpToolCall'), id: z.string().min(1),
  server: tool.shape.server, tool: tool.shape.toolName, status: z.literal('failed'),
  arguments: z.object({ sessionId: uuid, text: z.string().min(1) }) })
  .transform(({ id, arguments: args }) => ({ id, recipientId: args.sessionId }));
type FailedSend = z.infer<typeof failedSend>;
const desktopReview = z.object({ type: z.literal('automaticApprovalReview'), targetItemId: z.string().min(1),
  action: tool, event: z.object({ status: z.literal('denied') }),
  serverCompletedAtMs: timestamp.nullish().catch(undefined), completedAtMs: timestamp.nullish().catch(undefined) });
const desktopTurn = z.object({ turnId: uuid, status: terminal, items: z.unknown(),
  turnStartedAtMs: timestamp.nullish().catch(undefined), durationMs: z.number().nonnegative().nullish().catch(undefined) });
const appServerReview = z.object({ turnId: uuid, targetItemId: z.string().min(1), completedAtMs: timestamp,
  action: tool, review: z.object({ status: z.literal('denied') }) });
const appServerItem = z.object({ turnId: uuid, item: failedSend });
const appServerTurn = z.object({ turn: z.object({ id: uuid, status: terminal, items: z.array(z.unknown()).default([]) }) });

function reportMatches(turnId: string, sends: FailedSend[], denials: Map<string, number>, report: ReplyBlockedHandler) {
  const latest = new Map<string, number>();
  for (const send of sends) {
    const time = denials.get(send.id);
    if (time !== undefined && time > (latest.get(send.recipientId) ?? 0)) latest.set(send.recipientId, time);
  }
  for (const [recipientId, deniedAtMs] of latest) report({ turnId, recipientId, deniedAtMs });
}

function failedSends(items: unknown[]) {
  return items.flatMap(item => failedSend.safeParse(item).data ?? []);
}

export function observeDesktopReplyBlocks(report: ReplyBlockedHandler, since = Date.now()) {
  const seen = new Set<string>();
  return (state: Parameters<typeof desktopTurnEntries>[0]) => {
    for (const value of desktopTurnEntries(state)) {
      const turn = desktopTurn.safeParse(value).data;
      if (!turn || !Array.isArray(turn.items)) continue;
      if (turn.turnStartedAtMs != null && turn.durationMs != null && turn.turnStartedAtMs + turn.durationMs < since) continue;
      const denials = new Map<string, number>();
      for (const item of turn.items) {
        const review = desktopReview.safeParse(item).data;
        const time = review?.serverCompletedAtMs ?? review?.completedAtMs;
        if (review && time != null && time >= since && time > (denials.get(review.targetItemId) ?? 0)) {
          denials.set(review.targetItemId, time);
        }
      }
      if (!denials.size) continue;
      reportMatches(turn.turnId, failedSends(turn.items), denials, event => {
        const key = event.turnId + ':' + event.recipientId;
        if (seen.has(key)) return;
        seen.add(key);
        report(event);
      });
    }
  };
}

export function observeAppServerReplyBlocks(report: ReplyBlockedHandler): AppServerReplyObserver {
  const calls = new Map<string, Map<string, FailedSend>>();
  const denials = new Map<string, Map<string, number>>();
  return (method, params) => {
    if (method === 'item/autoApprovalReview/completed') {
      const event = appServerReview.safeParse(params).data;
      if (!event) return;
      const reviews = denials.get(event.turnId) ?? new Map<string, number>();
      if (event.completedAtMs > (reviews.get(event.targetItemId) ?? 0)) reviews.set(event.targetItemId, event.completedAtMs);
      denials.set(event.turnId, reviews);
    } else if (method === 'item/completed') {
      const event = appServerItem.safeParse(params).data;
      if (!event) return;
      const turn = calls.get(event.turnId) ?? new Map<string, FailedSend>();
      turn.set(event.item.id, event.item);
      calls.set(event.turnId, turn);
    } else if (method === 'turn/completed') {
      const turn = appServerTurn.safeParse(params).data?.turn;
      if (!turn) return;
      const reviews = denials.get(turn.id);
      const items = calls.get(turn.id);
      denials.delete(turn.id);
      calls.delete(turn.id);
      if (reviews?.size) reportMatches(turn.id, [...failedSends(turn.items), ...(items?.values() ?? [])], reviews, report);
    }
  };
}
