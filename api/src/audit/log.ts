import { InferInsertModel } from 'drizzle-orm';
import { auditLog } from '../db/schema';

export type AuditLogInsert = InferInsertModel<typeof auditLog>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const writeAuditLog = async (db: any, data: AuditLogInsert) => db.insert(auditLog).values(data);
