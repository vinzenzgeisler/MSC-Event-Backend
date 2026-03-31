import { InferInsertModel } from 'drizzle-orm';
import { auditLog } from '../db/schema';

export type AuditLogInsert = InferInsertModel<typeof auditLog>;

const allowedPayloadKeysByAction: Record<string, string[]> = {
  class_created: ['eventId', 'classId', 'vehicleType'],
  class_updated: ['classId', 'fieldMask'],
  class_deleted: ['classId'],
  checkin_id_verified_set: ['checkinIdVerified'],
  document_generated: ['type', 'templateVariant', 'templateVersion', 'sha256', 's3Key'],
  batch_document_generated: ['type', 'templateVersion', 'count', 's3Key'],
  document_download_url_issued: ['expiresInSeconds'],
  entry_status_updated: ['from', 'to'],
  entry_class_updated: ['previousClassId', 'classId', 'isBackupVehicle', 'backupOfEntryId', 'backupVehicleId'],
  entry_tech_status_updated: ['techStatus'],
  entry_notes_updated: ['internalNoteUpdated', 'driverNoteUpdated'],
  entry_payment_status_set: ['paymentStatus', 'paidAmountCents', 'amountOpenCents', 'invoiceId'],
  entry_payment_amounts_set: ['invoiceId', 'totalCents', 'paidAmountCents', 'amountOpenCents', 'paymentStatus'],
  entry_soft_deleted: ['classId', 'driverPersonId', 'registrationStatus', 'acceptanceStatus', 'startNumberNorm', 'deleteReason'],
  entry_restored: [],
  event_created: ['status'],
  event_activated: ['isCurrent'],
  event_closed: ['status'],
  event_archived: ['status'],
  event_updated: ['fieldMask'],
  export_created: ['type', 'rowCount', 'redacted'],
  export_download_url_issued: ['expiresInSeconds'],
  pricing_rules_updated: ['eventId'],
  invoices_recalculated: ['updatedCount'],
  invoice_payment_recorded: ['invoiceId', 'amountCents', 'method'],
  email_outbox_queued: ['queued', 'templateId', 'templateVersion'],
  payment_reminders_queued: ['queued', 'skipped', 'reason', 'outboxIds', 'templateId', 'templateVersion'],
  lifecycle_email_queued: ['entryId', 'eventType', 'templateId', 'templateVersion'],
  broadcast_queued: ['queued', 'templateId', 'templateVersion'],
  email_outbox_retry_requested: ['previousStatus'],
  ai_message_imported: ['messageId', 'source', 'mailboxKey', 'eventId', 'entryId'],
  ai_message_reply_generated: ['messageId', 'category', 'confidence'],
  ai_message_chat_generated: ['messageId', 'contextMode', 'suggestionCount'],
  ai_report_generated: ['eventId', 'format', 'length'],
  ai_speaker_text_generated: ['eventId', 'entryId', 'classId', 'mode'],
  ai_draft_saved: ['draftId', 'taskType', 'status', 'eventId', 'entryId', 'messageId'],
  ai_draft_updated: ['draftId', 'taskType', 'messageId'],
  ai_knowledge_suggestions_generated: ['messageId', 'suggestionCount', 'topicHint'],
  ai_knowledge_item_saved: ['knowledgeItemId', 'suggestionId', 'topic', 'status'],
  public_entry_created: ['registrationStatus', 'registrationGroupId'],
  public_entry_verified: ['registrationStatus', 'registrationGroupId'],
  privacy_retention_run: ['windowStart', 'windowEnd', 'deletedRows', 'errors']
};

const sanitizePayload = (action: string, payload: unknown): Record<string, unknown> | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const allowedKeys = allowedPayloadKeysByAction[action];
  if (!allowedKeys) {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) {
      sanitized[key] = source[key];
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const writeAuditLog = async (db: any, data: AuditLogInsert) =>
  db.insert(auditLog).values({
    ...data,
    payload: sanitizePayload(data.action, data.payload)
  });
