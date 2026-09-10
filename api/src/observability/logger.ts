type LogLevel = 'info' | 'warn' | 'error';

const SAFE_KEYS = new Set([
  'stage',
  'requestId',
  'route',
  'method',
  'statusCode',
  'durationMs',
  'eventId',
  'entryId',
  'sessionId',
  'decisionId',
  'deviceSessionId',
  'documentId',
  'outboxId',
  'workflowType',
  'workflowStage',
  'target',
  'status',
  'errorCode',
  'attemptCount',
  'maxAttempts',
  'count',
  'queued',
  'processed',
  'recipientCount',
  'apiUnavailable',
  'outboxFailed',
  'outboxOverdue',
  'outboxStuckSending',
  'signingEvidenceIncomplete',
  'signingMailQueueFailed',
  'inspectionNotificationMissing',
  'registrationNotificationMissing',
  's3EvidenceMissing'
]);

const sanitizeFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => SAFE_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)
    )
  );

export const logOperationalEvent = (
  level: LogLevel,
  eventType: string,
  fields: Record<string, unknown> = {}
) => {
  const payload = {
    eventType,
    stage: process.env.STAGE ?? 'dev',
    ...sanitizeFields(fields)
  };
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.info(payload);
};

export const errorCodeOf = (error: unknown, fallback = 'UNKNOWN_ERROR'): string => {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_.:-]{1,100}$/i.test(candidate.code)) return candidate.code;
    if (typeof candidate.message === 'string' && /^[A-Z0-9_:-]{1,100}$/.test(candidate.message)) return candidate.message;
    current = candidate.cause;
  }
  const candidate = error as { name?: unknown } | null;
  if (candidate && typeof candidate.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(candidate.name)) return candidate.name;
  return fallback;
};
