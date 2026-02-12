import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { getAuthContext, hasAnyGroup, hasGroup } from './http/auth';
import { errorJson, json } from './http/response';
import { parseJsonBody } from './http/parse';
import { queueMail, queuePaymentReminders, validateQueueMailInput, validateReminderInput } from './routes/adminMail';
import { createTechCheckDocument, createWaiverDocument, getDocumentDownload, validateDocumentRequest } from './routes/adminDocs';

const isInvalidJson = (error: unknown): boolean =>
  error instanceof Error && error.message === 'Invalid JSON body';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const stage = process.env.STAGE ?? 'dev';

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true, stage });
  }

  if (method === 'GET' && path === '/admin/ping') {
    const auth = getAuthContext(event);

    return json(200, {
      ok: true,
      sub: auth.sub,
      groups: auth.groups
    });
  }

  if (method === 'GET' && path === '/admin/db/ping') {
    try {
      const db = await getDb();
      const result = await db.execute(sql`select current_database() as name, now() as now`);
      const row = result.rows[0] as { name?: string; now?: string } | undefined;

      return json(200, {
        ok: true,
        database: row?.name ?? null,
        now: row?.now ?? null
      });
    } catch (error) {
      return json(500, { ok: false, message: 'DB ping failed' });
    }
  }

  if (method === 'GET' && path === '/admin/db/schema') {
    try {
      const db = await getDb();
      const result = await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
        order by table_name
      `);

      return json(200, {
        ok: true,
        tables: result.rows.map((row) => row.table_name)
      });
    } catch (error) {
      return json(500, { ok: false, message: 'Schema query failed' });
    }
  }

  if (method === 'POST' && path === '/admin/mail/queue') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateQueueMailInput(payload);
      const result = await queueMail(input, auth.sub);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
        return errorJson(409, 'Duplicate request');
      }
      return errorJson(500, 'Mail queue failed');
    }
  }

  if (method === 'POST' && path === '/admin/payment/reminders/queue') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateReminderInput(payload);
      const result = await queuePaymentReminders(input, auth.sub);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
        return errorJson(409, 'Duplicate request');
      }
      return errorJson(500, 'Reminder queue failed');
    }
  }

  if (method === 'POST' && path === '/admin/documents/waiver') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateDocumentRequest(payload);
      const doc = await createWaiverDocument(input, auth.sub);
      if (!doc) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, documentId: doc.id });
    } catch (error) {
      console.error('create waiver document failed', error);
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      const details = stage === 'dev' && error instanceof Error ? { error: error.message } : undefined;
      return errorJson(500, 'Document generation failed', details);
    }
  }

  if (method === 'POST' && path === '/admin/documents/tech-check') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateDocumentRequest(payload);
      const doc = await createTechCheckDocument(input, auth.sub);
      if (!doc) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, documentId: doc.id });
    } catch (error) {
      console.error('create tech-check document failed', error);
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      const details = stage === 'dev' && error instanceof Error ? { error: error.message } : undefined;
      return errorJson(500, 'Document generation failed', details);
    }
  }

  const docDownloadMatch = path.match(/^\/admin\/documents\/([^/]+)\/download$/);
  if (method === 'GET' && docDownloadMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }

    const id = docDownloadMatch[1];
    try {
      const result = await getDocumentDownload(id);
      if (!result) {
        return errorJson(404, 'Document not found');
      }
      return json(200, { ok: true, url: result.url });
    } catch (error) {
      return errorJson(500, 'Download failed');
    }
  }

  return json(404, { message: 'Not Found' });
};
