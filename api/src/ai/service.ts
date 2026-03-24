import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { writeAuditLog } from '../audit/log';
import { aiDraft, aiMessageSource, appConfig, emailOutbox, entry, event, eventClass, invoice, person, vehicle } from '../db/schema';
import { getEntryConfirmationDefaults } from '../routes/adminConfig';
import { buildEntryConfirmationConfigFallback, overlayEntryConfirmationConfig } from '../domain/entryConfirmationConfig';
import { buildPaymentReference } from '../domain/paymentReference';
import { generateStructuredObject } from './bedrock';

const normalizeReplyCategory = (
  value: string
): 'zahlung' | 'nennung' | 'unterlagen' | 'presse' | 'eventlogistik' | 'rueckfrage' | 'sonstiges' => {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();

  if (normalized.includes('zahl')) {
    return 'zahlung';
  }
  if (normalized.includes('presse') || normalized.includes('akkredit') || normalized.includes('medien')) {
    return 'presse';
  }
  if (normalized.includes('anreise') || normalized.includes('fahrerlager') || normalized.includes('zeitplan') || normalized.includes('lauf')) {
    return 'eventlogistik';
  }
  if (
    normalized.includes('nenn') ||
    normalized.includes('anmeld')
  ) {
    return 'nennung';
  }
  if (normalized.includes('unterlag') || normalized.includes('dokument')) {
    return 'unterlagen';
  }
  if (normalized.includes('ruckfrage') || normalized.includes('frage') || normalized.includes('interview')) {
    return 'rueckfrage';
  }
  return 'sonstiges';
};

const warningSchema = z.object({
  code: z.string().min(1).max(80),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  message: z.string().min(1).max(400)
});

type AiWarning = z.infer<typeof warningSchema>;

const replySuggestionSchema = z.object({
  summary: z.string().min(1).max(600),
  category: z.string().transform(normalizeReplyCategory),
  replyDraft: z.string().min(1).max(4000),
  warnings: z.array(z.string()).max(8).default([]),
  confidence: z.enum(['low', 'medium', 'high'])
});

const reportSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  teaser: z.string().max(280).nullable().optional(),
  text: z.string().min(1).max(5000),
  warnings: z.array(z.string()).max(8).default([])
});

const speakerTextSchema = z.object({
  text: z.string().min(1).max(1500),
  facts: z.array(z.string()).max(8).default([]),
  warnings: z.array(z.string()).max(8).default([])
});

const renderJsonPrompt = (task: string, context: unknown, outputShapeHint: Record<string, string>) => [
  `Task: ${task}`,
  'Rules:',
  '- Use only the provided facts.',
  '- Do not invent results, rankings, lap times, sponsors, or personal details that are not present.',
  '- If context is missing, keep the output conservative and add warnings.',
  '- Return valid JSON only.',
  `Expected keys: ${JSON.stringify(outputShapeHint)}`,
  `Context: ${JSON.stringify(context)}`
].join('\n');

const buildReplySystemPrompt = () =>
  [
    'You are an assistant for the back office of a motorsport event system.',
    'Write the final replyDraft in German.',
    'Use the provided operational context whenever it is relevant.',
    'Be concrete when the context contains concrete facts, dates, contacts, payment details, or schedule items.',
    'Do not promise approvals, interviews, accreditations, or exceptions unless they are explicitly confirmed in the context.',
    'If the sender asks for something outside the available facts, say that it will be checked internally and add a warning.',
    'Return JSON with summary, category, replyDraft, warnings, confidence.'
  ].join(' ');

const buildReportSystemPrompt = () =>
  'You generate event communication drafts in German. Keep the text factual, presentation-ready, and based only on the supplied data. Return JSON with title, teaser, text, warnings.';

const buildSpeakerSystemPrompt = () =>
  'You generate short announcer-support text in German. Keep it lively but factual and easy to read aloud. Return JSON with text, facts, warnings.';

const resolveLengthHint = (length: 'short' | 'medium' | 'long'): string => {
  if (length === 'short') {
    return 'roughly 60-90 words';
  }
  if (length === 'long') {
    return 'roughly 220-320 words';
  }
  return 'roughly 120-180 words';
};

const AI_ASSISTANT_KNOWLEDGE_KEY = 'ai_assistant_knowledge';

const withTaskEnvelope = <TResult extends Record<string, unknown>, TBasis extends Record<string, unknown> | null>(input: {
  task: 'reply_suggestion' | 'event_report' | 'speaker_text';
  result: TResult;
  basis: TBasis;
  warnings: AiWarning[];
  confidence: 'low' | 'medium' | 'high';
  modelId: string;
  promptVersion?: string;
}) => ({
  task: input.task,
  result: input.result,
  basis: input.basis,
  warnings: input.warnings,
  review: {
    required: true,
    status: 'draft' as const,
    confidence: input.confidence
  },
  meta: {
    modelId: input.modelId,
    promptVersion: input.promptVersion ?? 'v1',
    generatedAt: new Date().toISOString()
  }
});

const normalizeWarnings = (warnings: string[], fallbackCode: string): AiWarning[] =>
  warnings.map((warning) => ({
    code: fallbackCode,
    severity: 'medium' as const,
    message: warning
  }));

const toCompactArray = (values: Array<string | null | undefined>, limit = 8): string[] =>
  values
    .map((value) => (value ?? '').trim())
    .filter((value) => value.length > 0)
    .slice(0, limit);

const stringifySchedule = (items: Array<{ label?: string | null; startsAt?: string | null; endsAt?: string | null; note?: string | null }> | null | undefined) =>
  (items ?? [])
    .map((item) => [item.label, item.startsAt, item.endsAt, item.note].filter((value) => Boolean(value)).join(' | '))
    .filter((value) => value.length > 0)
    .slice(0, 8);

const loadAssistantKnowledge = async () => {
  const db = await getDb();
  const rows = await db
    .select({
      payload: appConfig.payload
    })
    .from(appConfig)
    .where(eq(appConfig.configKey, AI_ASSISTANT_KNOWLEDGE_KEY))
    .limit(1);

  const payload = (rows[0]?.payload ?? {}) as Record<string, unknown>;
  return {
    faq: Array.isArray(payload.faq) ? payload.faq.slice(0, 10) : [],
    pressNotes: Array.isArray(payload.pressNotes) ? payload.pressNotes.slice(0, 8) : [],
    logisticsNotes: Array.isArray(payload.logisticsNotes) ? payload.logisticsNotes.slice(0, 8) : [],
    responsePolicy: typeof payload.responsePolicy === 'string' ? payload.responsePolicy : null
  };
};

const loadMessageContext = async (messageId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiMessageSource.id,
      eventId: aiMessageSource.eventId,
      entryId: aiMessageSource.entryId,
      fromEmail: aiMessageSource.fromEmail,
      subject: aiMessageSource.subject,
      textContent: aiMessageSource.textContent,
      eventName: event.name,
      eventContactEmail: event.contactEmail,
      eventWebsiteUrl: event.websiteUrl,
      eventEntryConfirmationConfig: event.entryConfirmationConfig,
      className: eventClass.name,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      startNumber: entry.startNumberNorm,
      acceptanceStatus: entry.acceptanceStatus,
      registrationStatus: entry.registrationStatus,
      driverNote: entry.driverNote,
      internalNote: entry.internalNote,
      orgaCode: entry.orgaCode,
      entryFeeCents: entry.entryFeeCents,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      paymentStatus: invoice.paymentStatus,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents
    })
    .from(aiMessageSource)
    .leftJoin(event, eq(aiMessageSource.eventId, event.id))
    .leftJoin(entry, eq(aiMessageSource.entryId, entry.id))
    .leftJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(eq(aiMessageSource.id, messageId))
    .limit(1);
  return rows[0] ?? null;
};

const loadRecentOutgoingMessages = async (eventId: string | null, toEmail: string | null) => {
  if (!eventId || !toEmail) {
    return [];
  }
  const db = await getDb();
  const rows = await db
    .select({
      subject: emailOutbox.subject,
      templateId: emailOutbox.templateId,
      status: emailOutbox.status,
      createdAt: emailOutbox.createdAt
    })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.toEmail, toEmail)))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(5);
  return rows.map((row) => ({
    subject: row.subject,
    templateId: row.templateId,
    status: row.status,
    createdAt: row.createdAt
  }));
};

const loadEventReportContext = async (eventId: string) => {
  const db = await getDb();
  const eventRows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      contactEmail: event.contactEmail,
      websiteUrl: event.websiteUrl,
      status: event.status
    })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  const current = eventRows[0];
  if (!current) {
    return null;
  }
  const [counts, classRows] = await Promise.all([
    db
      .select({
        entriesTotal: sql<number>`count(*)::int`,
        acceptedTotal: sql<number>`count(*) filter (where ${entry.acceptanceStatus} = 'accepted')::int`,
        paidTotal: sql<number>`count(*) filter (where ${invoice.paymentStatus} = 'paid')::int`
      })
      .from(entry)
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`)),
    db
      .select({
        className: eventClass.name,
        count: sql<number>`count(${entry.id})::int`
      })
      .from(eventClass)
      .leftJoin(entry, and(eq(entry.classId, eventClass.id), sql`${entry.deletedAt} is null`))
      .where(eq(eventClass.eventId, eventId))
      .groupBy(eventClass.name)
      .orderBy(asc(eventClass.name))
  ]);
  return {
    event: current,
    counts: counts[0] ?? { entriesTotal: 0, acceptedTotal: 0, paidTotal: 0 },
    classes: classRows
  };
};

const loadClassReportContext = async (eventId: string, classId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      eventId: event.id,
      eventName: event.name,
      classId: eventClass.id,
      className: eventClass.name
    })
    .from(eventClass)
    .innerJoin(event, eq(eventClass.eventId, event.id))
    .where(and(eq(eventClass.eventId, eventId), eq(eventClass.id, classId)))
    .limit(1);

  const current = rows[0];
  if (!current) {
    return null;
  }

  const counts = await db
    .select({
      entriesTotal: sql<number>`count(*)::int`,
      acceptedTotal: sql<number>`count(*) filter (where ${entry.acceptanceStatus} = 'accepted')::int`,
      paidTotal: sql<number>`count(*) filter (where ${invoice.paymentStatus} = 'paid')::int`
    })
    .from(entry)
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(eq(entry.eventId, eventId), eq(entry.classId, classId), sql`${entry.deletedAt} is null`))
    .limit(1);

  return {
    event: {
      id: current.eventId,
      name: current.eventName
    },
    class: {
      id: current.classId,
      name: current.className
    },
    counts: counts[0] ?? { entriesTotal: 0, acceptedTotal: 0, paidTotal: 0 }
  };
};

const loadSpeakerContext = async (input: { eventId: string; entryId?: string; classId?: string }) => {
  const db = await getDb();
  if (input.entryId) {
    const rows = await db
      .select({
        eventName: event.name,
        className: eventClass.name,
        startNumber: entry.startNumberNorm,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        nationality: person.nationality,
        motorsportHistory: person.motorsportHistory,
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        vehicleHistory: vehicle.vehicleHistory
      })
      .from(entry)
      .innerJoin(event, eq(entry.eventId, event.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
      .where(and(eq(entry.id, input.entryId), eq(entry.eventId, input.eventId), sql`${entry.deletedAt} is null`))
      .limit(1);
    return rows[0] ?? null;
  }

  if (!input.classId) {
    return null;
  }

  const rows = await db
    .select({
      eventName: event.name,
      className: eventClass.name,
      driverName: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || coalesce(${person.lastName}, ''))`,
      startNumber: entry.startNumberNorm
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(and(eq(entry.eventId, input.eventId), eq(entry.classId, input.classId), sql`${entry.deletedAt} is null`))
    .orderBy(desc(entry.updatedAt))
    .limit(8);

  if (rows.length === 0) {
    return null;
  }

  return {
    eventName: rows[0].eventName,
    className: rows[0].className,
    participants: rows.map((row) => ({
      driverName: row.driverName,
      startNumber: row.startNumber
    }))
  };
};

export const generateReplySuggestion = async (
  messageId: string,
  input: { tone: 'friendly' | 'neutral' | 'formal'; includeWarnings?: boolean },
  actorUserId: string | null
) => {
  const db = await getDb();
  const [current, assistantKnowledge, globalEntryConfirmationDefaults] = await Promise.all([
    loadMessageContext(messageId),
    loadAssistantKnowledge(),
    getEntryConfirmationDefaults()
  ]);
  if (!current) {
    return null;
  }

  const entryConfirmationConfig = overlayEntryConfirmationConfig(
    overlayEntryConfirmationConfig(buildEntryConfirmationConfigFallback(), globalEntryConfirmationDefaults.config),
    (current.eventEntryConfirmationConfig ?? {}) as never
  );
  const recentOutgoing = await loadRecentOutgoingMessages(current.eventId ?? null, current.fromEmail ?? null);
  const amountOpenCents = Math.max(0, (current.totalCents ?? 0) - (current.paidAmountCents ?? 0));
  const paymentReference =
    current.entryId && current.driverFirstName && current.driverLastName
      ? buildPaymentReference({
          orgaCode: current.orgaCode,
          firstName: current.driverFirstName,
          lastName: current.driverLastName
        })
      : null;
  const context = {
    tone: input.tone,
    includeWarnings: input.includeWarnings ?? true,
    message: {
      fromEmail: current.fromEmail,
      subject: current.subject,
      text: current.textContent
    },
    event: current.eventId
      ? {
          id: current.eventId,
          name: current.eventName,
          contactEmail: current.eventContactEmail ?? entryConfirmationConfig.organizerContactEmail,
          websiteUrl: current.eventWebsiteUrl ?? entryConfirmationConfig.websiteUrl,
          organizerName: entryConfirmationConfig.organizerName,
          organizerPhone: entryConfirmationConfig.organizerContactPhone,
          venue: [entryConfirmationConfig.venueName, entryConfirmationConfig.venueStreet, entryConfirmationConfig.venueZip, entryConfirmationConfig.venueCity]
            .filter(Boolean)
            .join(', '),
          arrivalNotes: entryConfirmationConfig.arrivalNotes,
          accessNotes: entryConfirmationConfig.accessNotes,
          paddockInfo: entryConfirmationConfig.paddockInfo,
          importantNotes: toCompactArray(entryConfirmationConfig.importantNotes ?? []),
          schedule: stringifySchedule(entryConfirmationConfig.scheduleItems)
        }
      : null,
    entry: current.entryId
      ? {
          id: current.entryId,
          className: current.className,
          driverName: [current.driverFirstName, current.driverLastName].filter(Boolean).join(' ').trim() || null,
          driverEmail: current.driverEmail,
          startNumber: current.startNumber,
          acceptanceStatus: current.acceptanceStatus,
          registrationStatus: current.registrationStatus,
          orgaCode: current.orgaCode,
          vehicleLabel: [current.vehicleMake, current.vehicleModel].filter(Boolean).join(' ').trim() || null,
          paymentStatus: current.paymentStatus,
          entryFeeCents: current.entryFeeCents,
          amountOpenCents,
          paymentRecipient: entryConfirmationConfig.paymentRecipient,
          paymentIban: entryConfirmationConfig.paymentIban,
          paymentReference,
          driverNote: current.driverNote,
          internalNote: current.internalNote
        }
      : null,
    previousOutgoingCommunication: recentOutgoing,
    knowledgeBase: assistantKnowledge
  };

  const generated = await generateStructuredObject({
    schema: replySuggestionSchema,
    systemPrompt: buildReplySystemPrompt(),
    userPrompt: renderJsonPrompt('summarize, categorize and draft a reply', context, {
      summary: 'string',
      category: 'zahlung|nennung|unterlagen|presse|eventlogistik|rueckfrage|sonstiges',
      replyDraft: 'string',
      warnings: 'string[]',
      confidence: 'low|medium|high'
    })
  });

  const now = new Date();
  await db
    .update(aiMessageSource)
    .set({
      aiSummary: generated.data.summary,
      aiCategory: generated.data.category,
      aiLastProcessedAt: now,
      status: 'processed',
      updatedAt: now
    })
    .where(eq(aiMessageSource.id, messageId));

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'ai_message_reply_generated',
    entityType: 'ai_message_source',
    entityId: messageId as never,
    payload: {
      messageId,
      category: generated.data.category,
      confidence: generated.data.confidence
    }
  });

  const warnings = normalizeWarnings(generated.data.warnings ?? [], 'REVIEW_NOTE');
  const missingDocumentWarning =
    generated.data.category === 'unterlagen'
      ? [
          {
            code: 'MISSING_DOCUMENT_DETAILS',
            severity: 'medium' as const,
            message: 'Es gibt keinen strukturierten Datensatz, welche Unterlagen konkret fehlen.'
          }
        ]
      : [];

  return {
    messageId,
    ...withTaskEnvelope({
      task: 'reply_suggestion',
      result: {
        summary: generated.data.summary,
        category: generated.data.category,
        replyDraft: generated.data.replyDraft,
        analysis: {
          intent: generated.data.category,
          language: 'de'
        }
      },
      basis: {
        message: {
          id: messageId,
          subject: current.subject
        },
        event: current.eventId
          ? {
              id: current.eventId,
              name: current.eventName,
              contactEmail: current.eventContactEmail ?? entryConfirmationConfig.organizerContactEmail
            }
          : null,
        entry: current.entryId
          ? {
              id: current.entryId,
              registrationStatus: current.registrationStatus,
              acceptanceStatus: current.acceptanceStatus,
              paymentStatus: current.paymentStatus,
              amountOpenCents,
              paymentReference
            }
          : null,
        usedKnowledge: {
          faqCount: assistantKnowledge.faq.length,
          logisticsNotesCount: assistantKnowledge.logisticsNotes.length,
          previousOutgoingCount: recentOutgoing.length
        }
      },
      warnings: [...warnings, ...missingDocumentWarning],
      confidence: generated.data.confidence,
      modelId: generated.modelId
    })
  };
};

export const generateEventReport = async (
  input: {
    eventId: string;
    classId?: string;
    scope: 'event' | 'class';
    formats: Array<'website' | 'short_summary'>;
    tone: 'neutral' | 'friendly' | 'formal';
    length: 'short' | 'medium' | 'long';
    highlights?: string[];
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const eventContext = input.scope === 'class' && input.classId ? await loadClassReportContext(input.eventId, input.classId) : null;
  const generalContext = input.scope === 'event' ? await loadEventReportContext(input.eventId) : null;
  const context = eventContext ?? generalContext;
  if (!context || (input.scope === 'class' && !eventContext)) {
    return null;
  }
  const variants = await Promise.all(
    input.formats.map(async (format) => {
      const generated = await generateStructuredObject({
        schema: reportSchema,
        systemPrompt: buildReportSystemPrompt(),
        userPrompt: renderJsonPrompt(
          'generate an event communication draft',
          {
            scope: input.scope,
            targetFormat: format,
            tone: input.tone,
            targetLength: resolveLengthHint(input.length),
            event: context.event,
            class: 'class' in context ? context.class : null,
            counts: context.counts,
            classes: 'classes' in context ? context.classes : undefined,
            highlights: input.highlights ?? []
          },
          {
            title: 'string?',
            teaser: 'string|null',
            text: 'string',
            warnings: 'string[]'
          }
        )
      });

      return {
        generated,
        format
      };
    })
  );

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'ai_report_generated',
    entityType: 'event',
    entityId: input.eventId as never,
    payload: {
      eventId: input.eventId,
      format: input.formats[0] ?? null,
      length: input.length
    }
  });

  const warnings = [
    ...variants.flatMap((variant) => normalizeWarnings(variant.generated.data.warnings ?? [], 'REVIEW_NOTE')),
    {
      code: 'NO_RESULTS_DATA',
      severity: 'medium' as const,
      message: 'Es liegen keine strukturierten Ergebnisdaten vor; der Text basiert auf Stammdaten und manuellen Highlights.'
    }
  ];

  return {
    eventId: input.eventId,
    ...withTaskEnvelope({
      task: 'event_report',
      result: {
        variants: variants.map((variant) => ({
          format: variant.format,
          title: variant.generated.data.title ?? null,
          teaser: variant.generated.data.teaser ?? null,
          text: variant.generated.data.text
        }))
      },
      basis: {
        scope: input.scope,
        event: context.event,
        class: 'class' in context ? context.class : null,
        facts: context.counts,
        highlights: input.highlights ?? []
      },
      warnings,
      confidence: warnings.length > 1 ? 'medium' : 'high',
      modelId: variants[0]?.generated.modelId ?? 'unknown'
    })
  };
};

export const generateSpeakerText = async (
  input: {
    eventId: string;
    entryId?: string;
    classId?: string;
    mode: 'short_intro' | 'driver_intro' | 'class_overview';
    highlights?: string[];
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const context = await loadSpeakerContext(input);
  if (!context) {
    return null;
  }
  const generated = await generateStructuredObject({
    schema: speakerTextSchema,
    systemPrompt: buildSpeakerSystemPrompt(),
    userPrompt: renderJsonPrompt(
      'generate announcer support text',
      {
        mode: input.mode,
        context,
        highlights: input.highlights ?? []
      },
      {
        text: 'string',
        facts: 'string[]',
        warnings: 'string[]'
      }
    ),
    maxTokens: 500
  });

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'ai_speaker_text_generated',
    entityType: input.entryId ? 'entry' : 'class',
    entityId: (input.entryId ?? input.classId) as never,
    payload: {
      eventId: input.eventId,
      entryId: input.entryId ?? null,
      classId: input.classId ?? null,
      mode: input.mode
    }
  });

  return {
    eventId: input.eventId,
    ...withTaskEnvelope({
      task: 'speaker_text',
      result: {
        text: generated.data.text,
        facts: generated.data.facts
      },
      basis: {
        focusType: input.entryId ? 'entry' : 'class',
        context,
        highlights: input.highlights ?? []
      },
      warnings: normalizeWarnings(generated.data.warnings ?? [], 'INCOMPLETE_SPEAKER_CONTEXT'),
      confidence: (generated.data.warnings ?? []).length > 0 ? 'medium' : 'high',
      modelId: generated.modelId
    })
  };
};

export const saveGeneratedDraft = async (
  input: {
    taskType: 'reply_suggestion' | 'event_report' | 'speaker_text';
    title?: string;
    status?: 'draft' | 'reviewed' | 'archived';
    eventId?: string;
    entryId?: string;
    messageId?: string;
    promptVersion?: string;
    modelId?: string;
    inputSnapshot?: Record<string, unknown>;
    outputPayload: Record<string, unknown>;
    warnings?: Array<string | AiWarning>;
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();
  const [created] = await db
    .insert(aiDraft)
    .values({
      taskType: input.taskType,
      status: input.status ?? 'draft',
      eventId: input.eventId ?? null,
      entryId: input.entryId ?? null,
      messageId: input.messageId ?? null,
      title: input.title ?? null,
      promptVersion: input.promptVersion ?? 'v1',
      modelId: input.modelId ?? null,
      inputSnapshot: input.inputSnapshot ?? {},
      outputPayload: input.outputPayload,
      warnings: (input.warnings ?? []).map((warning) =>
        typeof warning === 'string'
          ? {
              code: 'REVIEW_NOTE',
              severity: 'medium',
              message: warning
            }
          : warning
      ),
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now
    })
    .returning({
      id: aiDraft.id,
      taskType: aiDraft.taskType,
      status: aiDraft.status,
      eventId: aiDraft.eventId,
      entryId: aiDraft.entryId,
      messageId: aiDraft.messageId,
      createdAt: aiDraft.createdAt
    });

  if (!created) {
    throw new Error('AI_DRAFT_SAVE_FAILED');
  }

  await writeAuditLog(db as never, {
    eventId: created.eventId,
    actorUserId,
    action: 'ai_draft_saved',
    entityType: 'ai_draft',
    entityId: created.id as never,
    payload: {
      draftId: created.id,
      taskType: created.taskType,
      status: created.status,
      eventId: created.eventId,
      entryId: created.entryId,
      messageId: created.messageId
    }
  });

  return created;
};

export const listGeneratedDrafts = async (query: {
  taskType?: 'reply_suggestion' | 'event_report' | 'speaker_text';
  eventId?: string;
  limit?: number;
}) => {
  const db = await getDb();
  const conditions = [];
  if (query.taskType) {
    conditions.push(eq(aiDraft.taskType, query.taskType));
  }
  if (query.eventId) {
    conditions.push(eq(aiDraft.eventId, query.eventId));
  }

  const rows = await db
    .select({
      id: aiDraft.id,
      taskType: aiDraft.taskType,
      title: aiDraft.title,
      status: aiDraft.status,
      eventId: aiDraft.eventId,
      entryId: aiDraft.entryId,
      messageId: aiDraft.messageId,
      createdAt: aiDraft.createdAt,
      updatedAt: aiDraft.updatedAt
    })
    .from(aiDraft)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(aiDraft.createdAt))
    .limit(query.limit ?? 20);

  return rows;
};
