import { z } from 'zod';
import { uuid } from './claude';

export type TurnFailure = { id: string; errorCode: string; finishedAt: number };
export type TurnFailureHandler = (failure: TurnFailure) => void;

const errorCodes = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
  'flexUnavailable', 'serverOverloaded', 'modelNotFound', 'policyCapacityUnavailable', 'inferenceHookDenied',
  'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed',
  'sandboxError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable',
]);

const errorSchema = z.object({ codexErrorInfo: z.unknown() }).nullish();
const timeMs = z.number().int().nonnegative().max(8_640_000_000_000_000);
const turnSchema = z.object({ status: z.string(), error: errorSchema.catch(undefined) });

function errorCode(info: unknown): string {
  const keys = info && typeof info === 'object' ? Object.keys(info) : [];
  const code = typeof info === 'string' ? info : keys.length === 1 ? keys[0] : undefined;
  return code && errorCodes.has(code) ? code : 'other';
}

const appServerTurn = turnSchema.extend({ id: uuid, completedAt: z.number().nullish().catch(undefined) });

export function appServerTurnFailure(turn: unknown): TurnFailure | undefined {
  const parsed = appServerTurn.safeParse(turn).data;
  if (parsed?.status !== 'failed') return;
  const finishedAt = timeMs.safeParse((parsed.completedAt ?? 0) * 1000).data;
  return { id: parsed.id, errorCode: errorCode(parsed.error?.codexErrorInfo), finishedAt: finishedAt || Date.now() };
}

const desktopTurn = turnSchema.extend({
  turnId: uuid,
  turnStartedAtMs: timeMs.nullish().catch(undefined),
  durationMs: timeMs.nullish().catch(undefined),
});
const desktopHistory = z.object({
  kind: z.literal('canonical'),
  history: z.object({ entitiesByKey: z.record(z.string(), z.unknown()) }),
});

export function observeDesktopTurnFailures(report: TurnFailureHandler, since = Date.now()) {
  const active = new Set<string>();
  const reported = new Set<string>();
  return (state: { turns?: unknown; turnHistory?: unknown }) => {
    const history = desktopHistory.safeParse(state.turnHistory).data;
    const turns = [...(Array.isArray(state.turns) ? state.turns : []),
      ...Object.values(history?.history.entitiesByKey ?? {})];
    for (const value of turns) {
      const turn = desktopTurn.safeParse(value).data;
      if (!turn) continue;
      if (turn.status === 'inProgress') { active.add(turn.turnId); continue; }
      const seenRunning = active.delete(turn.turnId);
      if (turn.status !== 'failed' || reported.has(turn.turnId)) continue;
      const finishedAt = turn.turnStartedAtMs != null && turn.durationMs != null
        ? timeMs.safeParse(turn.turnStartedAtMs + turn.durationMs).data : undefined;
      // Loading historical pages or enabling the receiver must not replay past failures.
      if (!seenRunning && (finishedAt === undefined || finishedAt < since)) continue;
      reported.add(turn.turnId);
      report({ id: turn.turnId, errorCode: errorCode(turn.error?.codexErrorInfo), finishedAt: finishedAt ?? Date.now() });
    }
  };
}

// Message streaming updates items frequently. Refresh only on turn outcomes or structural changes.
export function desktopTurnOutcomePatch(path: (string | number)[]) {
  if (path[0] === 'turns') return path.length <= 2 || ['status', 'error', 'durationMs'].includes(String(path[2]));
  return path[0] === 'turnHistory' && (path.length <= 2
    || path[2] === 'entitiesByKey' && (path.length <= 4 || ['status', 'error', 'durationMs'].includes(String(path[4]))));
}
