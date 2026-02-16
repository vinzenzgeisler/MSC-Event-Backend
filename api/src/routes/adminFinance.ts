import { and, asc, eq, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { classPricingRule, entry, eventPricingRule, invoice, invoicePayment } from '../db/schema';
import { assertEventStatusAllowed } from '../domain/eventStatus';

const classRuleSchema = z.object({
  classId: z.string().uuid(),
  baseFeeCents: z.number().int().min(0)
});

const pricingRulesSchema = z.object({
  earlyDeadline: z.string().datetime(),
  lateFeeCents: z.number().int().min(0),
  secondVehicleDiscountCents: z.number().int().min(0).default(8000),
  classRules: z.array(classRuleSchema).min(1)
});

const recalcSchema = z.object({
  driverPersonId: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional()
});

const listInvoiceFiltersSchema = z.object({
  eventId: z.string().uuid(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  driverPersonId: z.string().uuid().optional()
});

const paymentSchema = z.object({
  amountCents: z.number().int().positive(),
  paidAt: z.string().datetime(),
  method: z.enum(['bank_transfer', 'cash', 'card', 'other']),
  note: z.string().max(1000).optional()
});

type PricingRulesInput = z.infer<typeof pricingRulesSchema>;
type RecalcInput = z.infer<typeof recalcSchema>;
type PaymentInput = z.infer<typeof paymentSchema>;
type ListInvoiceFilters = z.infer<typeof listInvoiceFiltersSchema>;

type EntryForPricing = {
  entryId: string;
  eventId: string;
  driverPersonId: string;
  classId: string;
  createdAt: Date;
};

const loadPricingInputs = async (eventId: string, driverPersonId?: string): Promise<EntryForPricing[]> => {
  const db = await getDb();
  const query = db
    .select({
      entryId: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      classId: entry.classId,
      createdAt: entry.createdAt
    })
    .from(entry)
    .where(driverPersonId ? and(eq(entry.eventId, eventId), eq(entry.driverPersonId, driverPersonId)) : eq(entry.eventId, eventId))
    .orderBy(asc(entry.driverPersonId), asc(entry.createdAt));
  return query;
};

export const putPricingRules = async (eventId: string, input: PricingRulesInput, actorUserId: string | null) => {
  await assertEventStatusAllowed(eventId, ['draft', 'open', 'closed']);
  const db = await getDb();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(eventPricingRule)
      .values({
        eventId,
        earlyDeadline: new Date(input.earlyDeadline),
        lateFeeCents: input.lateFeeCents,
        secondVehicleDiscountCents: input.secondVehicleDiscountCents,
        currency: 'EUR',
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: eventPricingRule.eventId,
        set: {
          earlyDeadline: new Date(input.earlyDeadline),
          lateFeeCents: input.lateFeeCents,
          secondVehicleDiscountCents: input.secondVehicleDiscountCents,
          currency: 'EUR',
          updatedAt: now
        }
      });

    await tx.delete(classPricingRule).where(eq(classPricingRule.eventId, eventId));
    await tx.insert(classPricingRule).values(
      input.classRules.map((rule) => ({
        eventId,
        classId: rule.classId,
        baseFeeCents: rule.baseFeeCents,
        updatedAt: now
      }))
    );

    await writeAuditLog(tx as never, {
      eventId,
      actorUserId,
      action: 'pricing_rules_updated',
      entityType: 'event_pricing_rule',
      payload: {
        lateFeeCents: input.lateFeeCents,
        secondVehicleDiscountCents: input.secondVehicleDiscountCents,
        classRulesCount: input.classRules.length
      }
    });
  });
};

const buildPricingSnapshot = (
  rows: EntryForPricing[],
  classFeeByClassId: Map<string, number>,
  earlyDeadline: Date,
  lateFeeCents: number,
  secondVehicleDiscountCents: number
) => {
  const byDriver = new Map<string, EntryForPricing[]>();
  for (const row of rows) {
    const bucket = byDriver.get(row.driverPersonId) ?? [];
    bucket.push(row);
    byDriver.set(row.driverPersonId, bucket);
  }

  return Array.from(byDriver.entries()).map(([driverPersonId, entries]) => {
    const lines = entries.map((current, idx) => {
      const baseFee = classFeeByClassId.get(current.classId) ?? 0;
      const lateFee = current.createdAt > earlyDeadline ? lateFeeCents : 0;
      const secondVehicleDiscount = idx >= 1 ? secondVehicleDiscountCents : 0;
      const total = baseFee + lateFee - secondVehicleDiscount;
      return {
        entryId: current.entryId,
        classId: current.classId,
        baseFeeCents: baseFee,
        lateFeeCents: lateFee,
        secondVehicleDiscountCents: secondVehicleDiscount,
        lineTotalCents: total < 0 ? 0 : total,
        submittedAt: current.createdAt.toISOString()
      };
    });

    const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    return {
      driverPersonId,
      totalCents,
      snapshot: {
        ruleVersion: 1,
        generatedAt: new Date().toISOString(),
        earlyDeadline: earlyDeadline.toISOString(),
        lateFeeCents,
        secondVehicleDiscountCents,
        lines,
        totalCents
      }
    };
  });
};

export const recalculateInvoices = async (eventId: string, input: RecalcInput, actorUserId: string | null) => {
  await assertEventStatusAllowed(eventId, ['draft', 'open', 'closed']);
  const db = await getDb();
  const ruleRows = await db.select().from(eventPricingRule).where(eq(eventPricingRule.eventId, eventId)).limit(1);
  const rules = ruleRows[0];
  if (!rules) {
    throw new Error('PRICING_RULES_NOT_FOUND');
  }

  const classRules = await db
    .select({
      classId: classPricingRule.classId,
      baseFeeCents: classPricingRule.baseFeeCents
    })
    .from(classPricingRule)
    .where(eq(classPricingRule.eventId, eventId));
  const classFeeByClassId = new Map(classRules.map((row) => [row.classId, row.baseFeeCents]));

  let driverPersonId = input.driverPersonId;
  if (input.invoiceId && !driverPersonId) {
    const invoiceRows = await db
      .select({ driverPersonId: invoice.driverPersonId })
      .from(invoice)
      .where(eq(invoice.id, input.invoiceId))
      .limit(1);
    if (invoiceRows.length === 0) {
      throw new Error('INVOICE_NOT_FOUND');
    }
    driverPersonId = invoiceRows[0].driverPersonId;
  }

  const pricingRows = await loadPricingInputs(eventId, driverPersonId);
  const computed = buildPricingSnapshot(
    pricingRows,
    classFeeByClassId,
    rules.earlyDeadline,
    rules.lateFeeCents,
    rules.secondVehicleDiscountCents
  );

  const now = new Date();
  for (const row of computed) {
    await db
      .insert(invoice)
      .values({
        eventId,
        driverPersonId: row.driverPersonId,
        totalCents: row.totalCents,
        pricingSnapshot: row.snapshot,
        paymentStatus: 'due',
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [invoice.eventId, invoice.driverPersonId],
        set: {
          totalCents: row.totalCents,
          pricingSnapshot: row.snapshot,
          paymentStatus: sql`case when ${invoice.paidAmountCents} >= ${row.totalCents} then 'paid' else 'due' end`,
          paidAt: sql`case when ${invoice.paidAmountCents} >= ${row.totalCents} then ${invoice.paidAt} else null end`,
          updatedAt: now
        }
      });
  }

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'invoices_recalculated',
    entityType: 'invoice_batch',
    payload: {
      recalculated: computed.length,
      scopedDriverPersonId: driverPersonId ?? null
    }
  });

  return { recalculated: computed.length };
};

export const listInvoices = async (filters: ListInvoiceFilters) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [eq(invoice.eventId, filters.eventId)];
  if (filters.paymentStatus) {
    conditions.push(eq(invoice.paymentStatus, filters.paymentStatus));
  }
  if (filters.driverPersonId) {
    conditions.push(eq(invoice.driverPersonId, filters.driverPersonId));
  }

  return db
    .select({
      id: invoice.id,
      eventId: invoice.eventId,
      driverPersonId: invoice.driverPersonId,
      totalCents: invoice.totalCents,
      paymentStatus: invoice.paymentStatus,
      paidAt: invoice.paidAt,
      paidAmountCents: invoice.paidAmountCents,
      pricingSnapshot: invoice.pricingSnapshot,
      updatedAt: invoice.updatedAt
    })
    .from(invoice)
    .where(and(...conditions))
    .orderBy(asc(invoice.createdAt));
};

export const recordInvoicePayment = async (invoiceId: string, input: PaymentInput, actorUserId: string | null) => {
  const db = await getDb();
  const invoiceRows = await db
    .select({
      id: invoice.id,
      eventId: invoice.eventId,
      totalCents: invoice.totalCents
    })
    .from(invoice)
    .where(eq(invoice.id, invoiceId))
    .limit(1);
  const current = invoiceRows[0];
  if (!current) {
    return null;
  }
  await assertEventStatusAllowed(current.eventId, ['open', 'closed']);

  const paidAt = new Date(input.paidAt);
  const now = new Date();
  await db.insert(invoicePayment).values({
    invoiceId,
    amountCents: input.amountCents,
    paidAt,
    method: input.method,
    recordedBy: actorUserId,
    note: input.note,
    createdAt: now
  });

  const sumRows = await db
    .select({
      paidAmountCents: sql<number>`coalesce(sum(${invoicePayment.amountCents}), 0)`,
      maxPaidAt: sql<Date | string | null>`max(${invoicePayment.paidAt})`
    })
    .from(invoicePayment)
    .where(eq(invoicePayment.invoiceId, invoiceId));

  const paidAmountCents = sumRows[0]?.paidAmountCents ?? 0;
  const maxPaidAtRaw = sumRows[0]?.maxPaidAt ?? null;
  const maxPaidAt = maxPaidAtRaw ? new Date(maxPaidAtRaw) : null;
  const paymentStatus = paidAmountCents >= current.totalCents ? 'paid' : 'due';

  const [updated] = await db
    .update(invoice)
    .set({
      paidAmountCents,
      paymentStatus,
      paidAt: paymentStatus === 'paid' ? maxPaidAt : null,
      recordedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(invoice.id, invoiceId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'invoice_payment_recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    payload: {
      amountCents: input.amountCents,
      method: input.method,
      paymentStatus
    }
  });

  return updated ?? null;
};

export const listInvoicePayments = async (invoiceId: string) => {
  const db = await getDb();
  return db
    .select({
      id: invoicePayment.id,
      invoiceId: invoicePayment.invoiceId,
      amountCents: invoicePayment.amountCents,
      paidAt: invoicePayment.paidAt,
      method: invoicePayment.method,
      recordedBy: invoicePayment.recordedBy,
      note: invoicePayment.note,
      createdAt: invoicePayment.createdAt
    })
    .from(invoicePayment)
    .where(eq(invoicePayment.invoiceId, invoiceId))
    .orderBy(asc(invoicePayment.paidAt));
};

export const validatePricingRulesInput = (payload: unknown) => pricingRulesSchema.parse(payload);
export const validateRecalcInput = (payload: unknown) => recalcSchema.parse(payload ?? {});
export const validateListInvoicesInput = (query: Record<string, string | undefined>) =>
  listInvoiceFiltersSchema.parse({
    eventId: query.eventId,
    paymentStatus: query.paymentStatus,
    driverPersonId: query.driverPersonId
  });
export const validateRecordPaymentInput = (payload: unknown) => paymentSchema.parse(payload);
