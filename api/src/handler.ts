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
  validateListEventsInput,
  updateEvent,
  validateUpdateEventInput
} from './routes/adminEvents';
import {
  createClass,
  deleteClass,
  listClassesByEventWithQuery,
  updateClass,
  validateClassInput,
  validateClassUpdateInput
} from './routes/adminClasses';
import {
  getExportDownload,
  getExportJob,
  listExportJobs,
  createEntriesExport,
  validateCreateExportInput
} from './routes/adminExports';
import {
  deleteEntry,
  listCheckinEntries,
  listDeletedEntries,
  listEntries,
  restoreEntry,
  getEntryDetail,
  patchEntryStatus,
  patchEntryTechStatus,
  patchEntryNotes,
  patchEntryPaymentStatus,
  patchEntryPaymentAmounts,
  validateEntryStatusPatchInput,
  validateEntryTechStatusPatchInput,
  validateEntryNotesPatchInput,
  validateEntryPaymentStatusPatchInput,
  validateEntryPaymentAmountsPatchInput,
  validateEntryDeleteInput,
  validateListEntriesQuery
} from './routes/adminEntries';
import {
  getPricingRules,
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
  createIamUser,
  listIamRoles,
  listIamUsers,
  patchIamUserRoles,
  patchIamUserStatus,
  validateCreateIamUserInput,
  validateListIamUsersInput,
  validatePatchIamUserRolesInput,
  validatePatchIamUserStatusInput
} from './routes/adminIam';
import {
  DuplicateRequestError,
  queueBroadcastMail,
  queueLifecycleMail,
  queueMail,
  queuePaymentReminders,
  listOutbox,
  retryOutboxMail,
  validateBroadcastInput,
  validateLifecycleInput,
  validateListOutboxInput,
  validateQueueMailInput,
  validateReminderInput
} from './routes/adminMail';
import { getDashboardSummary, validateDashboardSummaryQuery } from './routes/adminDashboard';
import {
  createTechCheckBatchDocument,
  createTechCheckDocument,
  createWaiverBatchDocument,
  createWaiverDocument,
  getDocumentDownload,
  getOrCreateEntryDocumentDownload,
  validateBatchDocumentRequest,
  validateDocumentRequest
} from './routes/adminDocs';
import { setCheckinIdVerified, validateIdVerifyInput } from './routes/adminCheckin';
import {
  createPublicEntry,
  finalizeVehicleImageUpload,
  getPublicCurrentEventWithClasses,
  initVehicleImageUpload,
  validateCreatePublicEntryInput,
  validatePublicStartNumber,
  validatePublicStartNumberInput,
  validateVehicleImageUploadFinalizeInput,
  validateVehicleImageUploadInitInput,
  validateVerifyPublicEntryInput,
  verifyPublicEntryEmail
} from './routes/publicRegistration';

const isInvalidJson = (error: unknown): boolean =>
  error instanceof Error && error.message === 'Invalid JSON body';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const stage = process.env.STAGE ?? 'dev';
  const adminAuth = path.startsWith('/admin/') ? getAuthContext(event) : null;

  if (adminAuth && !adminAuth.sub) {
    return errorJson(401, 'Unauthorized');
  }

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true, stage });
  }

  const publicCreateEntryMatch = path.match(/^\/public\/events\/([^/]+)\/entries$/);
  if (method === 'POST' && publicCreateEntryMatch) {
    try {
      const payload = parseJsonBody(event);
      const input = validateCreatePublicEntryInput({
        ...(payload as Record<string, unknown>),
        eventId: publicCreateEntryMatch[1]
      });
      const result = await createPublicEntry(input);
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
      if (error instanceof Error && (error.message === 'EVENT_NOT_OPEN' || error.message === 'REGISTRATION_NOT_OPEN' || error.message === 'REGISTRATION_CLOSED')) {
        return errorJson(409, error.message);
      }
      if (error instanceof Error && error.message === 'CLASS_NOT_FOUND') {
        return errorJson(404, 'Class not found');
      }
      if (error instanceof Error && error.message === 'CLASS_VEHICLE_TYPE_MISMATCH') {
        return errorJson(409, 'Class does not match vehicle type');
      }
      if (error instanceof Error && error.message === 'START_NUMBER_INVALID_FORMAT') {
        return errorJson(
          400,
          'Validation failed',
          undefined,
          'VALIDATION_ERROR',
          [{ field: 'startNumber', code: 'invalid_format', message: 'Start number must match ^[A-Z0-9]{1,6}$' }]
        );
      }
      if (error instanceof Error && error.message === 'BACKUP_LINK_REQUIRED') {
        return errorJson(
          400,
          'Validation failed',
          undefined,
          'VALIDATION_ERROR',
          [{ field: 'backupOfEntryId', code: 'required_when_backup_vehicle', message: 'Backup link is required for backup vehicles' }]
        );
      }
      if (error instanceof Error && error.message === 'BACKUP_ENTRY_NOT_FOUND') {
        return errorJson(404, 'Referenced backup entry not found', undefined, 'BACKUP_ENTRY_NOT_FOUND');
      }
      if (error instanceof Error && error.message === 'BACKUP_ENTRY_INVALID_LINK') {
        return errorJson(409, 'Backup entry link is invalid', undefined, 'BACKUP_ENTRY_INVALID_LINK');
      }
      if (error instanceof Error && error.message === 'IMAGE_UPLOAD_INVALID') {
        return errorJson(
          400,
          'Validation failed',
          undefined,
          'VALIDATION_ERROR',
          [{ field: 'vehicle.imageUploadId', code: 'invalid_or_not_finalized', message: 'Image upload is invalid or not finalized' }]
        );
      }
      if (error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
        return errorJson(
          409,
          'Validation failed',
          undefined,
          'VALIDATION_ERROR',
          [{ field: 'startNumber', code: 'not_unique_in_event_class', message: 'Start number already exists' }]
        );
      }
      return errorJson(500, 'Public registration failed');
    }
  }

  if (method === 'GET' && path === '/public/events/current') {
    try {
      const current = await getPublicCurrentEventWithClasses();
      if (!current) {
        return errorJson(404, 'Current event not found');
      }
      return json(200, { ok: true, ...current });
    } catch (error) {
      return errorJson(500, 'Get current public event failed');
    }
  }

  const publicStartNumberValidateMatch = path.match(/^\/public\/events\/([^/]+)\/start-number\/validate$/);
  if (method === 'POST' && publicStartNumberValidateMatch) {
    try {
      const payload = parseJsonBody(event);
      const input = validatePublicStartNumberInput({
        ...(payload as Record<string, unknown>),
        eventId: publicStartNumberValidateMatch[1]
      });
      const result = await validatePublicStartNumber(input);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'CLASS_NOT_FOUND') {
        return errorJson(404, 'Class not found');
      }
      return errorJson(500, 'Start number validation failed');
    }
  }

  if (method === 'POST' && path === '/public/uploads/vehicle-image/init') {
    try {
      const payload = parseJsonBody(event);
      const input = validateVehicleImageUploadInitInput(payload);
      const created = await initVehicleImageUpload(input);
      return json(200, { ok: true, ...created });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found', undefined, 'EVENT_NOT_FOUND');
      }
      if (
        error instanceof Error &&
        (error.message === 'EVENT_NOT_OPEN' ||
          error.message === 'REGISTRATION_NOT_OPEN' ||
          error.message === 'REGISTRATION_CLOSED')
      ) {
        return errorJson(409, error.message, undefined, error.message);
      }
      return errorJson(500, 'Upload init failed');
    }
  }

  if (method === 'POST' && path === '/public/uploads/vehicle-image/finalize') {
    try {
      const payload = parseJsonBody(event);
      const input = validateVehicleImageUploadFinalizeInput(payload);
      const finalized = await finalizeVehicleImageUpload(input);
      return json(200, { ok: true, ...finalized });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'UPLOAD_NOT_FOUND') {
        return errorJson(404, 'Upload not found', undefined, 'UPLOAD_NOT_FOUND');
      }
      if (error instanceof Error && error.message === 'UPLOAD_EXPIRED') {
        return errorJson(409, 'Upload expired', undefined, 'UPLOAD_EXPIRED');
      }
      if (error instanceof Error && error.message === 'UPLOAD_OBJECT_MISSING') {
        return errorJson(409, 'Uploaded object not found', undefined, 'UPLOAD_OBJECT_MISSING');
      }
      return errorJson(500, 'Upload finalize failed');
    }
  }

  const publicVerifyMatch = path.match(/^\/public\/entries\/([^/]+)\/verify-email$/);
  if (method === 'POST' && publicVerifyMatch) {
    try {
      const payload = parseJsonBody(event);
      const input = validateVerifyPublicEntryInput(payload);
      const result = await verifyPublicEntryEmail(publicVerifyMatch[1], input);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'VERIFY_TOKEN_INVALID') {
        return errorJson(404, 'Verification token invalid');
      }
      if (error instanceof Error && error.message === 'VERIFY_TOKEN_EXPIRED') {
        return errorJson(409, 'Verification token expired');
      }
      return errorJson(500, 'Email verification failed');
    }
  }

  if (method === 'GET' && path === '/admin/ping') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }

    return json(200, {
      ok: true,
      sub: auth.sub,
      groups: auth.groups
    });
  }

  if (method === 'GET' && path === '/admin/auth/me') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }

    return json(200, {
      ok: true,
      sub: auth.sub,
      email: auth.email,
      roles: auth.groups,
      mfaAuthenticated: auth.mfaAuthenticated
    });
  }

  if (method === 'GET' && path === '/admin/dashboard/summary') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const query = validateDashboardSummaryQuery(event.queryStringParameters ?? {});
      const result = await getDashboardSummary(query.eventId);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      return errorJson(500, 'Get dashboard summary failed');
    }
  }

  if (method === 'GET' && path === '/admin/db/ping') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
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
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
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
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const queryInput = validateListEventsInput(event.queryStringParameters ?? {});
      const rows = await listEvents(queryInput);
      return json(200, { ok: true, events: rows.items, meta: rows.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List events failed');
    }
  }

  if (method === 'GET' && path === '/admin/events/current') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
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

  const eventPatchMatch = path.match(/^\/admin\/events\/([^/]+)$/);
  if (method === 'PATCH' && eventPatchMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateUpdateEventInput(payload);
      const updated = await updateEvent(eventPatchMatch[1], input, auth.sub);
      if (!updated) {
        return errorJson(404, 'Event not found');
      }
      return json(200, { ok: true, event: updated });
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
      return errorJson(500, 'Update event failed');
    }
  }

  const eventClassesMatch = path.match(/^\/admin\/events\/([^/]+)\/classes$/);
  if (method === 'GET' && eventClassesMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const classes = await listClassesByEventWithQuery(eventClassesMatch[1], {
        cursor: event.queryStringParameters?.cursor,
        limit: event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined,
        sortBy: event.queryStringParameters?.sortBy,
        sortDir: event.queryStringParameters?.sortDir as 'asc' | 'desc' | undefined
      });
      return json(200, { ok: true, classes: classes.items, meta: classes.meta });
    } catch (error) {
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List classes failed');
    }
  }

  if (method === 'POST' && eventClassesMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateClassInput(payload);
      const created = await createClass(eventClassesMatch[1], input, auth.sub);
      return json(200, { ok: true, class: created });
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
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      return errorJson(500, 'Create class failed');
    }
  }

  const classMatch = path.match(/^\/admin\/classes\/([^/]+)$/);
  if (method === 'PATCH' && classMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateClassUpdateInput(payload);
      const updated = await updateClass(classMatch[1], input, auth.sub);
      if (!updated) {
        return errorJson(404, 'Class not found');
      }
      return json(200, { ok: true, class: updated });
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
      return errorJson(500, 'Update class failed');
    }
  }

  if (method === 'DELETE' && classMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const deleted = await deleteClass(classMatch[1], auth.sub);
      if (!deleted) {
        return errorJson(404, 'Class not found');
      }
      return json(200, { ok: true, ...deleted });
    } catch (error) {
      if (error instanceof Error && error.message === 'CLASS_IN_USE') {
        return errorJson(409, 'Class is in use');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Delete class failed');
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
      if (error instanceof DuplicateRequestError) {
        return errorJson(
          409,
          'Duplicate request',
          {
            existingOutboxId: error.existingOutboxId,
            blockedUntil: error.blockedUntil
          },
          'DUPLICATE_REQUEST'
        );
      }
      if (error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
        return errorJson(409, 'Duplicate request', undefined, 'DUPLICATE_REQUEST');
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
      if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
        return errorJson(404, 'Template not found');
      }
      if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
        return errorJson(404, 'Entry not found');
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
    if (!hasGroup(auth, 'admin')) {
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
    if (!hasGroup(auth, 'admin')) {
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
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
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

  const entryDocDownloadMatch = path.match(/^\/admin\/documents\/entry\/([^/]+)\/download$/);
  if (method === 'GET' && entryDocDownloadMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const eventId = event.queryStringParameters?.eventId;
      const type = event.queryStringParameters?.type;
      if (!eventId || (type !== 'waiver' && type !== 'tech_check')) {
        return errorJson(400, 'eventId and type(waiver|tech_check) are required');
      }
      const result = await getOrCreateEntryDocumentDownload(
        {
          eventId,
          entryId: entryDocDownloadMatch[1],
          type
        },
        auth.sub
      );
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, {
        ok: true,
        url: result.url,
        type: result.doc.type,
        templateVariant: result.doc.templateVariant ?? null,
        templateVersion: result.doc.templateVersion
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      return errorJson(500, 'Download failed');
    }
  }

  if (method === 'GET' && path === '/admin/entries') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const query = validateListEntriesQuery(event.queryStringParameters ?? {});
      const redact = hasGroup(auth, 'viewer') && !hasGroup(auth, 'admin');
      const rows = await listEntries(query, redact);
      return json(200, { ok: true, entries: rows.items, meta: rows.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List entries failed');
    }
  }

  if (method === 'GET' && path === '/admin/entries/deleted') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const query = validateListEntriesQuery(event.queryStringParameters ?? {});
      const rows = await listDeletedEntries(query, false);
      return json(200, { ok: true, entries: rows.items, meta: rows.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List deleted entries failed');
    }
  }

  if (method === 'GET' && path === '/admin/checkin/entries') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const query = validateListEntriesQuery(event.queryStringParameters ?? {});
      const redact = hasGroup(auth, 'viewer') && !hasGroup(auth, 'admin');
      const rows = await listCheckinEntries(query, redact);
      return json(200, { ok: true, entries: rows.items, meta: rows.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List check-in entries failed');
    }
  }

  const entryDetailMatch = path.match(/^\/admin\/entries\/([^/]+)$/);
  if (method === 'GET' && entryDetailMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const redact = hasGroup(auth, 'viewer') && !hasGroup(auth, 'admin');
      const result = await getEntryDetail(entryDetailMatch[1], redact);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, ...result });
    } catch (error) {
      return errorJson(500, 'Get entry detail failed');
    }
  }

  const entryRestoreMatch = path.match(/^\/admin\/entries\/([^/]+)\/restore$/);
  if (method === 'POST' && entryRestoreMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const result = await restoreEntry(entryRestoreMatch[1], auth.sub);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof Error && error.message === 'RESTORE_CONFLICT') {
        return errorJson(409, 'Entry restore conflict', undefined, 'RESTORE_CONFLICT');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Entry restore failed');
    }
  }

  if (method === 'DELETE' && entryDetailMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateEntryDeleteInput(payload);
      const result = await deleteEntry(entryDetailMatch[1], input, auth.sub, auth.email ?? auth.sub);
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
      if (error instanceof Error && error.message === 'ENTRY_DELETE_FORBIDDEN_CHECKIN') {
        return errorJson(
          409,
          'Entry cannot be deleted after check-in verification',
          undefined,
          'CONFLICT',
          [{ field: 'checkinIdVerified', code: 'delete_forbidden', message: 'Entry is already check-in verified' }]
        );
      }
      if (error instanceof Error && error.message === 'ENTRY_DELETE_FORBIDDEN_TECH') {
        return errorJson(
          409,
          'Entry cannot be deleted after technical inspection',
          undefined,
          'CONFLICT',
          [{ field: 'techStatus', code: 'delete_forbidden', message: 'Entry tech status is no longer pending' }]
        );
      }
      if (error instanceof Error && error.message === 'ENTRY_DELETE_FORBIDDEN_PAYMENT') {
        return errorJson(
          409,
          'Entry cannot be deleted because payment data exists',
          undefined,
          'CONFLICT',
          [{ field: 'paymentStatus', code: 'delete_forbidden', message: 'Invoice is paid or has recorded payments' }]
        );
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Entry delete failed');
    }
  }

  const checkinMatch = path.match(/^\/admin\/entries\/([^/]+)\/checkin\/id-verify$/);
  if (method === 'PATCH' && checkinMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor'])) {
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

  const entryStatusMatch = path.match(/^\/admin\/entries\/([^/]+)\/status$/);
  if (method === 'PATCH' && entryStatusMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateEntryStatusPatchInput(payload);
      const result = await patchEntryStatus(entryStatusMatch[1], input, auth.sub);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, entry: result });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'LIFECYCLE_EVENT_TYPE_REQUIRED') {
        return errorJson(400, 'lifecycleEventType required when sendLifecycleMail=true');
      }
      if (error instanceof Error && error.message === 'INVALID_STATUS_TRANSITION') {
        return errorJson(
          409,
          'Acceptance status transition is not allowed',
          undefined,
          'INVALID_STATUS_TRANSITION',
          [{ field: 'acceptanceStatus', code: 'invalid_transition', message: 'Transition is not allowed' }]
        );
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Entry status update failed');
    }
  }

  const entryTechStatusMatch = path.match(/^\/admin\/entries\/([^/]+)\/tech-status$/);
  if (method === 'PATCH' && entryTechStatusMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor'])) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateEntryTechStatusPatchInput(payload);
      const result = await patchEntryTechStatus(entryTechStatusMatch[1], input, auth.sub);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, { ok: true, entry: result });
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
      return errorJson(500, 'Tech status update failed');
    }
  }

  const entryNotesMatch = path.match(/^\/admin\/entries\/([^/]+)\/notes$/);
  if (method === 'PATCH' && entryNotesMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateEntryNotesPatchInput(payload);
      const result = await patchEntryNotes(entryNotesMatch[1], input, auth.sub);
      if (!result) {
        return errorJson(404, 'Entry not found');
      }
      return json(200, {
        ok: true,
        entryId: result.id,
        internalNote: result.internalNote,
        driverNote: result.driverNote,
        updatedAt: result.updatedAt
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      return errorJson(500, 'Entry notes update failed');
    }
  }

  const entryPaymentStatusMatch = path.match(/^\/admin\/entries\/([^/]+)\/payment-status$/);
  if (method === 'PATCH' && entryPaymentStatusMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateEntryPaymentStatusPatchInput(payload);
      const result = await patchEntryPaymentStatus(entryPaymentStatusMatch[1], input, auth.sub);
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
      if (error instanceof Error && error.message === 'ENTRY_DELETED') {
        return errorJson(409, 'Entry is deleted', undefined, 'ENTRY_DELETED');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Entry payment status update failed');
    }
  }

  const entryPaymentAmountsMatch = path.match(/^\/admin\/entries\/([^/]+)\/payment-amounts$/);
  if (method === 'PATCH' && entryPaymentAmountsMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }

    try {
      const payload = parseJsonBody(event);
      const input = validateEntryPaymentAmountsPatchInput(payload);
      const result = await patchEntryPaymentAmounts(entryPaymentAmountsMatch[1], input, auth.sub);
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
      if (error instanceof Error && error.message === 'PAID_AMOUNT_EXCEEDS_TOTAL') {
        return errorJson(
          400,
          'Validation failed',
          undefined,
          'VALIDATION_ERROR',
          [{ field: 'paidAmountCents', code: 'invalid_range', message: 'paidAmountCents must not exceed totalCents' }]
        );
      }
      if (error instanceof Error && error.message === 'ENTRY_DELETED') {
        return errorJson(409, 'Entry is deleted', undefined, 'ENTRY_DELETED');
      }
      if (error instanceof Error && error.message === 'EVENT_STATUS_FORBIDDEN') {
        return errorJson(409, 'Event is read-only');
      }
      return errorJson(500, 'Entry payment amount update failed');
    }
  }

  const eventPricingMatch = path.match(/^\/admin\/events\/([^/]+)\/pricing-rules$/);
  if (method === 'GET' && eventPricingMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const result = await getPricingRules(eventPricingMatch[1]);
      return json(200, { ok: true, pricingRules: result });
    } catch (error) {
      if (error instanceof Error && error.message === 'EVENT_NOT_FOUND') {
        return errorJson(404, 'Event not found');
      }
      if (error instanceof Error && error.message === 'PRICING_RULES_NOT_FOUND') {
        return errorJson(404, 'Pricing rules not found');
      }
      return errorJson(500, 'Get pricing rules failed');
    }
  }

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
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const filters = validateListInvoicesInput(event.queryStringParameters ?? {});
      const invoices = await listInvoices(filters);
      return json(200, { ok: true, invoices: invoices.items, meta: invoices.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
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
      const details = stage === 'dev' && error instanceof Error ? { error: error.message } : undefined;
      return errorJson(500, 'Record payment failed', details);
    }
  }

  if (method === 'GET' && invoicePaymentsMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payments = await listInvoicePayments(invoicePaymentsMatch[1], {
        cursor: event.queryStringParameters?.cursor,
        limit: event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined,
        sortBy: event.queryStringParameters?.sortBy,
        sortDir: event.queryStringParameters?.sortDir as 'asc' | 'desc' | undefined
      });
      return json(200, { ok: true, payments: payments.items, meta: payments.meta });
    } catch (error) {
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List payments failed');
    }
  }

  if (method === 'POST' && path === '/admin/exports/entries') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
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

  if (method === 'GET' && path === '/admin/exports') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    const eventId = event.queryStringParameters?.eventId;
    if (!eventId) {
      return errorJson(400, 'eventId is required');
    }
    try {
      const jobs = await listExportJobs(eventId, {
        cursor: event.queryStringParameters?.cursor,
        limit: event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined,
        sortBy: event.queryStringParameters?.sortBy,
        sortDir: event.queryStringParameters?.sortDir as 'asc' | 'desc' | undefined
      });
      return json(200, { ok: true, exports: jobs.items, meta: jobs.meta });
    } catch (error) {
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List exports failed');
    }
  }

  const exportMatch = path.match(/^\/admin\/exports\/([^/]+)$/);
  if (method === 'GET' && exportMatch) {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
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
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
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

  if (method === 'GET' && path === '/admin/mail/outbox') {
    const auth = getAuthContext(event);
    if (!hasAnyGroup(auth, ['admin', 'editor', 'viewer'])) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const query = validateListOutboxInput(event.queryStringParameters ?? {});
      const outbox = await listOutbox(query);
      return json(200, { ok: true, outbox: outbox.items, meta: outbox.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && (error.message === 'INVALID_SORT_FIELD' || error.message === 'INVALID_CURSOR')) {
        return errorJson(400, error.message);
      }
      return errorJson(500, 'List outbox failed');
    }
  }

  const outboxRetryMatch = path.match(/^\/admin\/mail\/outbox\/([^/]+)\/retry$/);
  if (method === 'POST' && outboxRetryMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const updated = await retryOutboxMail(outboxRetryMatch[1], auth.sub);
      if (!updated) {
        return errorJson(404, 'Outbox mail not found');
      }
      return json(200, { ok: true, outbox: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'OUTBOX_RETRY_FORBIDDEN_STATUS') {
        return errorJson(409, 'Outbox message status cannot be retried');
      }
      return errorJson(500, 'Retry outbox failed');
    }
  }

  if (method === 'GET' && path === '/admin/iam/roles') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    return json(200, { ok: true, ...listIamRoles() });
  }

  if (method === 'GET' && path === '/admin/iam/users') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const query = validateListIamUsersInput(event.queryStringParameters ?? {});
      const result = await listIamUsers(query);
      if (!result) {
        return errorJson(500, 'List IAM users failed');
      }
      return json(200, { ok: true, users: result.users, meta: result.meta });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (error instanceof Error && error.message === 'IAM_INVALID_PARAMETER') {
        return errorJson(400, 'Invalid IAM query');
      }
      if (error instanceof Error && error.message === 'IAM_USER_POOL_NOT_CONFIGURED') {
        return errorJson(500, 'IAM is not configured');
      }
      return errorJson(500, 'List IAM users failed');
    }
  }

  if (method === 'POST' && path === '/admin/iam/users') {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validateCreateIamUserInput(payload);
      const created = await createIamUser(input);
      if (!created) {
        return errorJson(500, 'Create IAM user failed');
      }
      return json(200, { ok: true, user: created.user });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'IAM_USER_EXISTS') {
        return errorJson(409, 'User already exists');
      }
      if (error instanceof Error && error.message === 'IAM_INVALID_PARAMETER') {
        return errorJson(400, 'Invalid IAM user payload');
      }
      if (error instanceof Error && error.message === 'IAM_GROUP_NOT_FOUND') {
        return errorJson(400, 'Configured IAM role group not found');
      }
      if (error instanceof Error && error.message === 'IAM_USER_POOL_NOT_CONFIGURED') {
        return errorJson(500, 'IAM is not configured');
      }
      return errorJson(500, 'Create IAM user failed');
    }
  }

  const iamRolesMatch = path.match(/^\/admin\/iam\/users\/([^/]+)\/roles$/);
  if (method === 'PATCH' && iamRolesMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    let userId: string;
    try {
      userId = decodeURIComponent(iamRolesMatch[1]);
    } catch {
      return errorJson(400, 'Invalid user id');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validatePatchIamUserRolesInput(payload);
      const result = await patchIamUserRoles(userId, input);
      if (!result) {
        return errorJson(500, 'Patch IAM roles failed');
      }
      return json(200, { ok: true, user: result.user });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'IAM_USER_NOT_FOUND') {
        return errorJson(404, 'IAM user not found');
      }
      if (error instanceof Error && error.message === 'IAM_GROUP_NOT_FOUND') {
        return errorJson(400, 'Configured IAM role group not found');
      }
      if (error instanceof Error && error.message === 'IAM_USER_POOL_NOT_CONFIGURED') {
        return errorJson(500, 'IAM is not configured');
      }
      return errorJson(500, 'Patch IAM roles failed');
    }
  }

  const iamStatusMatch = path.match(/^\/admin\/iam\/users\/([^/]+)\/status$/);
  if (method === 'PATCH' && iamStatusMatch) {
    const auth = getAuthContext(event);
    if (!hasGroup(auth, 'admin')) {
      return errorJson(403, 'Forbidden');
    }
    let userId: string;
    try {
      userId = decodeURIComponent(iamStatusMatch[1]);
    } catch {
      return errorJson(400, 'Invalid user id');
    }
    try {
      const payload = parseJsonBody(event);
      const input = validatePatchIamUserStatusInput(payload);
      const result = await patchIamUserStatus(userId, input);
      if (!result) {
        return errorJson(500, 'Patch IAM status failed');
      }
      return json(200, { ok: true, user: result.user });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorJson(400, 'Validation failed', { issues: error.issues });
      }
      if (isInvalidJson(error)) {
        return errorJson(400, 'Invalid JSON body');
      }
      if (error instanceof Error && error.message === 'IAM_USER_NOT_FOUND') {
        return errorJson(404, 'IAM user not found');
      }
      if (error instanceof Error && error.message === 'IAM_USER_POOL_NOT_CONFIGURED') {
        return errorJson(500, 'IAM is not configured');
      }
      return errorJson(500, 'Patch IAM status failed');
    }
  }

  return errorJson(404, 'Not Found');
};
