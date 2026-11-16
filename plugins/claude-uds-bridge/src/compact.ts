import { z } from 'zod';
import type { Runtime } from './desktop';

export type CompactObservation = { runtime: Runtime; cwd: string; completed: string[]; running: string[] };
const itemSchema = z.object({ id: z.string(), type: z.string(), completed: z.boolean().optional(), source: z.string().optional(),
  completedAtMs: z.unknown().optional() });
const turnSchema = z.object({ items: z.array(itemSchema), completedItemIds: z.record(z.string(), z.boolean()).optional() });

// Stream items use completed/completedItemIds; canonical history uses completedAtMs.
// A finished turn alone does not prove that its compaction item completed.
export function desktopCompactions(state: { turns?: unknown; turnHistory?: unknown }, runtime: Runtime, cwd: string): CompactObservation {
  const turns = z.array(turnSchema).safeParse(state.turns);
  const history = z.object({ kind: z.string(), history: z.object({ entitiesByKey: z.record(z.string(), turnSchema) }).optional() }).safeParse(state.turnHistory);
  const values = turns.success ? [...turns.data] : [];
  if (history.success && history.data.kind === 'canonical' && history.data.history) values.push(...Object.values(history.data.history.entitiesByKey));
  const completed = new Set<string>(), running = new Set<string>();
  for (const turn of values) for (const item of turn.items) {
    if (item.type !== 'contextCompaction' || item.source === 'automatic') continue;
    const timestampComplete = typeof item.completedAtMs === 'number' && Number.isFinite(item.completedAtMs) && item.completedAtMs > 0;
    if (item.completed === true || turn.completedItemIds?.[item.id] === true || timestampComplete) completed.add(item.id);
    else running.add(item.id);
  }
  return { runtime, cwd, completed: [...completed], running: [...running].filter(id => !completed.has(id)) };
}

export function compactMarker(text: string) {
  const body = /^<cross-session-message\s[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/.exec(text)?.[1] ?? text;
  return body.trim() === '[bridge:compact]';
}
