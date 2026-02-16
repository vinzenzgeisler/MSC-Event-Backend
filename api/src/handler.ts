import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { getAuthContext, hasAnyGroup, hasGroup } from './http/auth';
import { errorJson, json } from './http/response';
import { parseJsonBody } from './http/parse';
import {
  archiveEvent,
  activateEvent,
  closeEvent,
  createEvent,
  getCurrentEvent,
  listEvents,
  validateCreateEventInput,
  validateListEventsInput
} from './routes/adminEvents';
import {
  getExportDownload,
  getExportJob,
  createEntriesExport,
  validateCreateExportInput
} from './routes/adminExports';
import {
  listInvoicePayments,
  listInvoices,
  putPricingRules,
  recalculateInvoices,
  recordInvoicePayment,
  validateListInvoicesInput,
  validatePricingRulesInput,
  validateRecalcInput,
  validateRecordPaymentInput
} from './routes/adminFinance';
import {
  queueBroadcastMail,
  queueLifecycleMail,
  queueMail,
  queuePaymentReminders,
  validateBroadcastInput,
  validateLifecycleInput,
  validateQueueMailInput,
  validateReminderInput
} from './routes/adminMail';
import {
  createTechCheckBatchDocument,
  createTechCheckDocument,
  createWaiverBatchDocument,
  createWaiverDocument,
  getDocumentDownload,
  validateBatchDocumentRequest,
  validateDocumentRequest
} from './routes/adminDocs';
import { setCheckinIdVerified, validateIdVerifyInput } from './routes/adminCheckin';

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

  if (method === 'GET' && path === '/admin/events') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const queryInput = validateListEventsInput(event.queryStringParameters ?? {});
      const rows = await listEvents(queryInput);
      return json(200, { ok: true, events: rows });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      return errorJson(500, 'List events failed');
    }
  }

  if (method === 'GET' && path === '/admin/events/current') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const current = await getCurrentEvent();
      if (!current) {
        return errorJson(404, 'Current event not found');
      }
      return json(200, { ok: true, event: current });
    } catch (error) {
      return errorJson(500, 'Get current event failed');
    }
  }

  if (method === 'POST' && path === '/admin/events') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateCreateEventInput(payload);
      const created = await createEvent(input, auth.sub);
      return json(200, { ok: true, event: created });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      return errorJson(500, 'Create event failed');
    }
  }

  const eventActivateMatch = path.match(/^\/admin\/events\/([^/]+)\/activate$/);
  if (method === 'POST' && eventActivateMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const updated = await activateEvent(eventActivateMatch[1], auth.sub);
      if (!updated) {
        return errorJson(404, 'Event not found');
      }
      return json(200, { ok: true, event: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'EVENT_TRANSITION_FORBIDDEN') {
        return errorJson(409, 'Event transition not allowed');
      }
      return errorJson(500, 'Activate event failed');
    }
  }

  const eventCloseMatch = path.match(/^\/admin\/events\/([^/]+)\/close$/);
  if (method === 'POST' && eventCloseMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const updated = await closeEvent(eventCloseMatch[1], auth.sub);
      if (!updated) {
        return errorJson(404, 'Event not found');
      }
      return json(200, { ok: true, event: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'EVENT_TRANSITION_FORBIDDEN') {
        return errorJson(409, 'Event transition not allowed');
      }
      return errorJson(500, 'Close event failed');
    }
  }

  const eventArchiveMatch = path.match(/^\/admin\/events\/([^/]+)\/archive$/);
  if (method === 'POST' && eventArchiveMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const updated = await archiveEvent(eventArchiveMatch[1], auth.sub);
      if (!updated) {
        return errorJson(404, 'Event not found');
      }
      return json(200, { ok: true, event: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'EVENT_TRANSITION_FORBIDDEN') {
        return errorJson(409, 'Event transition not allowed');
      }
      return errorJson(500, 'Archive event failed');
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
      if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
        return errorJson(404, 'Template not found');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
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
      if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
        return errorJson(404, 'Template not found');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Reminder queue failed');
    }
  }

  if (method === 'POST' && path === '/admin/mail/lifecycle/queue') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateLifecycleInput(payload);
      const result = await queueLifecycleMail(input, auth.sub);
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
      if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
        return errorJson(404, 'Template not found');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Lifecycle mail queue failed');
    }
  }

  if (method === 'POST' && path === '/admin/mail/broadcast/queue') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateBroadcastInput(payload);
      const result = await queueBroadcastMail(input, auth.sub);
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
      if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
        return errorJson(404, 'Template not found');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Broadcast mail queue failed');
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
      if (error instanceof Error && error.message === 'INVALID_VEHICLE_TYPE') {
        return errorJson(409, 'Vehicle type not supported for tech-check');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      const details = stage === 'dev' && error instanceof Error ? { error: error.message } : undefined;
      return errorJson(500, 'Document generation failed', details);
    }
  }

  if (method === 'POST' && path === '/admin/documents/tech-check') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateDocumentRequest(payload);
      const doc = await createTechCheckDocument(input, auth.sub);
      if (!doc) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, {
        ok: true,
        documentId: doc.id,
        type: doc.type,
        templateVariant: doc.templateVariant,
        templateVersion: doc.templateVersion,
        sha256: doc.sha256
      });
    } catch (error) {
      console.error('create tech-check document failed', error);
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      const details = stage === 'dev' && error instanceof Error ? { error: error.message } : undefined;
      return errorJson(500, 'Document generation failed', details);
    }
  }

  if (method === 'POST' && path === '/admin/documents/waiver/batch') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateBatchDocumentRequest(payload);
      const doc = await createWaiverBatchDocument(input, auth.sub);
      if (!doc) {
        return errorJson(404, 'Entries not found');
      }
      return json(200, { ok: true, documentId: doc.id });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Batch document generation failed');
    }
  }

  if (method === 'POST' && path === '/admin/documents/tech-check/batch') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateBatchDocumentRequest(payload);
      const doc = await createTechCheckBatchDocument(input, auth.sub);
      if (!doc) {
        return errorJson(404, 'Entries not found');
      }
      return json(200, { ok: true, documentId: doc.id });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Batch document generation failed');
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
      const result = await getDocumentDownload(id, auth.sub);
      if (!result) {
        return errorJson(404, 'Document not found');
      }
      return json(200, {
        ok: true,
        url: result.url,
        type: result.doc.type,
        templateVariant: result.doc.templateVariant ?? null,
        templateVersion: result.doc.templateVersion
      });
    } catch (error) {
      return errorJson(500, 'Download failed');
    }
  }

  const checkinMatch = path.match(/^\/admin\/entries\/([^/]+)\/checkin\/id-verify$/);
  if (method === 'PATCH' && checkinMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'checkin'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateIdVerifyInput(payload);
      const result = await setCheckinIdVerified(checkinMatch[1], input, auth.sub);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Check-in update failed');
    }
  }

  const eventPricingMatch = path.match(/^\/admin\/events\/([^/]+)\/pricing-rules$/);
  if (method === 'PUT' && eventPricingMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validatePricingRulesInput(payload);
      await putPricingRules(eventPricingMatch[1], input, auth.sub);
      return json(200, { ok: true });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Update pricing rules failed');
    }
  }

  const eventRecalcMatch = path.match(/^\/admin\/events\/([^/]+)\/invoices\/recalculate$/);
  if (method === 'POST' && eventRecalcMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateRecalcInput(payload);
      const result = await recalculateInvoices(eventRecalcMatch[1], input, auth.sub);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      if (error instanceof Error && error.message === 'PRICING_RULES_NOT_FOUND') {
        return errorJson(404, 'Pricing rules not found');
      }
      if (error instanceof Error && error.message === 'INVOICE_NOT_FOUND') {
        return errorJson(404, 'Invoice not found');
      }
      return errorJson(500, 'Recalculate invoices failed');
    }
  }

  if (method === 'GET' && path === '/admin/invoices') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const filters = validateListInvoicesInput(event.queryStringParameters ?? {});
      const invoices = await listInvoices(filters);
      return json(200, { ok: true, invoices });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      return errorJson(500, 'List invoices failed');
    }
  }

  const invoicePaymentsMatch = path.match(/^\/admin\/invoices\/([^/]+)\/payments$/);
  if (method === 'POST' && invoicePaymentsMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateRecordPaymentInput(payload);
      const updated = await recordInvoicePayment(invoicePaymentsMatch[1], input, auth.sub);
      if (!updated) {
        return errorJson(404, 'Invoice not found');
      }
      return json(200, { ok: true, invoice: updated });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Record payment failed');
    }
  }

  if (method === 'GET' && invoicePaymentsMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payments = await listInvoicePayments(invoicePaymentsMatch[1]);
      return json(200, { ok: true, payments });
    } catch (error) {
      return errorJson(500, 'List payments failed');
    }
  }

  if (method === 'POST' && path === '/admin/exports/entries') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateCreateExportInput(payload);
      const redacted = hasGroup(auth, 'viewer') && !hasGroup(auth, 'admin');
      const job = await createEntriesExport(input, auth.sub, redacted);
      return json(200, { ok: true, exportJobId: job.id, status: job.status });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      return errorJson(500, 'Create export failed');
    }
  }

  const exportMatch = path.match(/^\/admin\/exports\/([^/]+)$/);
  if (method === 'GET' && exportMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const job = await getExportJob(exportMatch[1]);
      if (!job) {
        return errorJson(404, 'Export job not found');
      }
      return json(200, { ok: true, export: job });
    } catch (error) {
      return errorJson(500, 'Get export failed');
    }
  }

  const exportDownloadMatch = path.match(/^\/admin\/exports\/([^/]+)\/download$/);
  if (method === 'GET' && exportDownloadMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const result = await getExportDownload(exportDownloadMatch[1], auth.sub);
      if (!result) {
        return errorJson(404, 'Export job not found');
      }
      return json(200, { ok: true, url: result.url, status: result.job.status });
    } catch (error) {
      if (error instanceof Error && error.message === 'EXPORT_NOT_READY') {
        return errorJson(409, 'Export not ready');
      }
      return errorJson(500, 'Get export download failed');
    }
  }

  return json(404, { message: 'Not Found' });
};
