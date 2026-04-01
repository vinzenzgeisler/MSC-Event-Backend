import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { writeAuditLog } from '../audit/log';
import {
  aiDraft,
  aiKnowledgeItem,
  aiKnowledgeSuggestion,
  aiMessageSource,
  appConfig,
  emailOutbox,
  entry,
  event,
  eventClass,
  invoice,
  person,
  vehicle
} from '../db/schema';
import { getEntryConfirmationDefaults } from '../routes/adminConfig';
import { buildEntryConfirmationConfigFallback, overlayEntryConfirmationConfig } from '../domain/entryConfirmationConfig';
import { buildPaymentReference } from '../domain/paymentReference';
import { generateStructuredObject } from './bedrock';
import { decodeMimeHeaderValue } from './imap';

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

const registrationStatusLabel = (value: string | null | undefined) => {
  if (value === 'submitted_verified') {
    return 'Die Nennung ist im System eingegangen und die E-Mail-Adresse ist bestätigt.';
  }
  if (value === 'submitted_unverified') {
    return 'Die Nennung ist im System eingegangen, aber die E-Mail-Adresse ist noch nicht bestätigt.';
  }
  return null;
};

const acceptanceStatusLabel = (value: string | null | undefined) => {
  if (value === 'accepted') {
    return 'Die Nennung ist zugelassen.';
  }
  if (value === 'shortlist') {
    return 'Die Nennung befindet sich in der Vorauswahl.';
  }
  if (value === 'pending') {
    return 'Die Nennung wird aktuell geprüft.';
  }
  if (value === 'rejected') {
    return 'Die Nennung ist abgelehnt.';
  }
  return null;
};

const paymentStatusLabel = (value: string | null | undefined, amountOpenCents: number) => {
  if (value === 'paid') {
    return 'Das Nenngeld ist vollständig bezahlt.';
  }
  if (value === 'due' && amountOpenCents > 0) {
    return `Es ist noch ein offener Betrag von ${(amountOpenCents / 100).toFixed(2).replace('.', ',')} EUR vermerkt.`;
  }
  if (value === 'due') {
    return 'Das Nenngeld ist noch nicht als bezahlt markiert.';
  }
  return null;
};

const warningSchema = z.object({
  code: z.string().min(1).max(80),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  message: z.string().min(1).max(400),
  displayMessage: z.string().min(1).max(400).optional(),
  recommendation: z.string().min(1).max(400).optional()
});

type AiWarning = z.infer<typeof warningSchema>;

const knowledgeTopicSchema = z.enum(['documents', 'payment', 'interview', 'logistics', 'contact', 'general']);
type KnowledgeTopic = z.infer<typeof knowledgeTopicSchema>;

const knowledgeSuggestionSchema = z.object({
  topic: knowledgeTopicSchema,
  title: z.string().min(1).max(180),
  content: z.string().min(1).max(3000),
  rationale: z.string().min(1).max(400).optional()
});

const looseKnowledgeSuggestionSchema = z.union([
  knowledgeSuggestionSchema,
  z.string().min(1).max(3000),
  z.object({
    topic: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    rationale: z.string().optional()
  })
]);

const knowledgeHitSchema = z.object({
  id: z.string().uuid().optional(),
  topic: knowledgeTopicSchema,
  title: z.string().min(1).max(180),
  content: z.string().min(1).max(3000)
});

const replySuggestionSchema = z.object({
  summary: z.string().min(1).max(600),
  category: z.string().transform(normalizeReplyCategory),
  replySubject: z.string().min(1).max(240).optional(),
  answerFacts: z.array(z.string().min(1).max(240)).max(8).default([]),
  unknowns: z.array(z.string().min(1).max(280)).max(8).default([]),
  replyDraft: z.string().min(1).max(4000),
  warnings: z.array(z.string()).max(8).default([]),
  confidence: z.enum(['low', 'medium', 'high'])
});

const reportSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  teaser: z.string().max(280).nullable().optional(),
  text: z.string().min(1).max(5000),
  warnings: z.array(z.string()).max(8).default([]),
  uncertainClaims: z.array(z.string().min(1).max(280)).max(8).default([])
});

const speakerTextSchema = z.object({
  text: z.string().min(1).max(1500),
  facts: z.array(z.string()).max(8).default([]),
  warnings: z.array(z.string()).max(8).default([])
});

const messageChatSchema = z.object({
  answer: z.string().min(1).max(3000),
  usedFacts: z.array(z.string().min(1).max(240)).max(10).default([]),
  unknowns: z.array(z.string().min(1).max(280)).max(8).default([]),
  knowledgeSuggestions: z.array(looseKnowledgeSuggestionSchema).max(8).default([])
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
    'Return a replySubject for the answer mail in German.',
    'Use the provided operational context whenever it is relevant.',
    'Be concrete when the context contains concrete facts, dates, contacts, payment details, or schedule items.',
    'Never mention internal status codes such as submitted_verified, accepted, due, or database field names in the replyDraft.',
    'Never claim that documents are missing unless the context explicitly lists missing documents.',
    'If the system has no concrete information about missing documents, say that no concrete document information is available in the system at the moment.',
    'Do not output placeholders like [Liste der fehlenden Dokumente] or bracketed TODOs.',
    'Do not promise approvals, interviews, accreditations, or exceptions unless they are explicitly confirmed in the context.',
    'If the sender asks for something outside the available facts, say that it will be checked internally and add a warning.',
    'Return JSON with summary, category, replySubject, replyDraft, warnings, confidence.'
  ].join(' ');

const buildReportSystemPrompt = () =>
  'You generate event communication drafts in German. Keep the text factual, presentation-ready, and based only on the supplied data. Do not invent results, rankings, lap times, sponsors, or quotes. If information is missing, mention it conservatively in warnings or uncertainClaims instead of implying facts. Return JSON with title, teaser, text, warnings, uncertainClaims.';

const buildSpeakerSystemPrompt = () =>
  'You generate short announcer-support text in German. Keep it lively but factual and easy to read aloud. Return JSON with text, facts, warnings.';

type ReportFormat = 'website' | 'short_summary';

type ReportVariantPayload = {
  format: ReportFormat;
  title: string | null;
  teaser: string | null;
  text: string;
  highlights: string[];
};

type ReportVariantReviewPayload = {
  format: ReportFormat;
  confidence: 'low' | 'medium' | 'high';
  blockingIssues: string[];
  uncertainClaims: string[];
  warnings: AiWarning[];
};

const buildChatSystemPrompt = (contextMode: 'reply' | 'knowledge_capture') =>
  [
    'You are an assistant for the back office of a motorsport event system.',
    'Answer in German.',
    'Use only the provided facts, approved knowledge items, and operator input.',
    'If information is missing, say so explicitly instead of assuming facts.',
    'Do not mention database field names or internal status codes.',
    contextMode === 'knowledge_capture'
      ? 'If the conversation reveals reusable factual information, return concise knowledgeSuggestions.'
      : 'knowledgeSuggestions should stay empty unless the context clearly contains reusable factual information.',
    'Return JSON with answer, usedFacts, unknowns, knowledgeSuggestions.'
  ].join(' ');

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

const detectKnowledgeTopics = (value: string): KnowledgeTopic[] => {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const topics = new Set<KnowledgeTopic>();
  if (/\bunterlag|\bdokument|\bnennung|\banmeldung/.test(normalized)) {
    topics.add('documents');
  }
  if (/\bzahl|\biban|\buberweis|\bnenngeld|\boffen\b/.test(normalized)) {
    topics.add('payment');
  }
  if (/\binterview|\bpresse|\bmedien|\bakkredit/.test(normalized)) {
    topics.add('interview');
  }
  if (/\banreise|\bfahrerlager|\bzeitplan|\bzugang|\bpark|\bablauf/.test(normalized)) {
    topics.add('logistics');
  }
  if (/\bkontakt|\bansprechpartner|\btelefon/.test(normalized)) {
    topics.add('contact');
  }
  if (topics.size === 0) {
    topics.add('general');
  }
  return Array.from(topics);
};

const buildKnowledgeHitPreview = (items: Array<{ id: string; topic: string; title: string; content: string }>) =>
  items.map((item) => ({
    id: item.id,
    topic: knowledgeTopicSchema.parse(item.topic),
    title: item.title,
    content: item.content
  }));

const uniqueStrings = (values: Array<string | null | undefined>, limit: number) =>
  Array.from(
    new Set(
      values
        .map((value) => (value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  ).slice(0, limit);

const inferKnowledgeTopic = (value: string, topicHint?: KnowledgeTopic): KnowledgeTopic => {
  if (topicHint) {
    return topicHint;
  }
  return detectKnowledgeTopics(value)[0] ?? 'general';
};

const normalizeKnowledgeSuggestions = (
  items: Array<z.infer<typeof looseKnowledgeSuggestionSchema>> | undefined,
  topicHint?: KnowledgeTopic
) => {
  const normalized: Array<z.infer<typeof knowledgeSuggestionSchema>> = [];
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      const content = item.trim();
      if (!content) {
        continue;
      }
      normalized.push({
        topic: inferKnowledgeTopic(content, topicHint),
        title: content.slice(0, 80),
        content,
        rationale: 'Aus frei formulierter Zusatzinfo abgeleitet.'
      });
      continue;
    }

    const content = item.content?.trim();
    if (!content) {
      continue;
    }

    const title = item.title?.trim() || content.slice(0, 80);
    const topic = item.topic ? knowledgeTopicSchema.safeParse(item.topic).data ?? inferKnowledgeTopic(content, topicHint) : inferKnowledgeTopic(content, topicHint);
    normalized.push({
      topic,
      title,
      content,
      rationale: item.rationale?.trim() || undefined
    });
  }

  return normalized.filter((item, index, array) => array.findIndex((candidate) => candidate.topic === item.topic && candidate.title === item.title && candidate.content === item.content) === index).slice(0, 5);
};

const splitKnowledgeCandidateText = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24);

const buildKnowledgeTitle = (topic: KnowledgeTopic, content: string) => {
  if (topic === 'interview') {
    return 'Interview-Anfragen';
  }
  if (topic === 'documents') {
    return 'Unterlagen und Dokumente';
  }
  if (topic === 'payment') {
    return 'Zahlung und Nenngeld';
  }
  if (topic === 'logistics') {
    return 'Event-Logistik';
  }
  if (topic === 'contact') {
    return 'Kontakt und Ansprechpartner';
  }
  return content.slice(0, 80);
};

const buildFallbackKnowledgeSuggestions = (input: {
  messageText: string;
  additionalContext?: string;
  history?: Array<{ role: 'user' | 'assistant'; message: string }>;
  topicHint?: KnowledgeTopic;
  approvedKnowledge: Array<{ topic: KnowledgeTopic; title: string; content: string }>;
}) => {
  const sources = [
    input.additionalContext ?? '',
    ...(input.history ?? []).filter((item) => item.role === 'user').map((item) => item.message)
  ]
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const candidates = sources.flatMap((item) => splitKnowledgeCandidateText(item));
  const messageTopics = detectKnowledgeTopics(input.messageText);

  const normalized = candidates
    .map((content) => {
      const topic = input.topicHint ?? detectKnowledgeTopics(content)[0] ?? messageTopics[0] ?? 'general';
      return {
        topic,
        title: buildKnowledgeTitle(topic, content),
        content,
        rationale: 'Aus manueller Zusatzinfo bzw. Rueckfrageverlauf abgeleitet.'
      };
    })
    .filter((item) => {
      const comparable = item.content.toLowerCase();
      return !input.approvedKnowledge.some((existing) => existing.topic === item.topic && existing.content.toLowerCase() === comparable);
    });

  return normalizeKnowledgeSuggestions(normalized, input.topicHint);
};

const withTaskEnvelope = <TResult extends Record<string, unknown>, TBasis extends Record<string, unknown> | null>(input: {
  task: 'reply_suggestion' | 'event_report' | 'speaker_text' | 'message_chat' | 'knowledge_suggestions';
  result: TResult;
  basis: TBasis;
  warnings: AiWarning[];
  confidence: 'low' | 'medium' | 'high';
  modelId: string;
  promptVersion?: string;
  reviewReason?: string;
  recommendedChecks?: string[];
  blockingIssues?: string[];
}) => ({
  task: input.task,
  result: input.result,
  basis: input.basis,
  warnings: input.warnings,
  review: {
    required: true,
    status: 'draft' as const,
    confidence: input.confidence,
    reason: input.reviewReason ?? 'KI-Ausgabe muss vor der Verwendung fachlich geprüft werden.',
    recommendedChecks: input.recommendedChecks ?? [],
    blockingIssues: input.blockingIssues ?? []
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
    message: warning,
    displayMessage: warning,
    recommendation: 'Bitte Inhalt und Datengrundlage vor der Übernahme prüfen.'
  }));

const buildReviewReason = (confidence: 'low' | 'medium' | 'high', warnings: AiWarning[]): string => {
  if (warnings.some((warning) => warning.severity === 'high')) {
    return 'Die Ausgabe enthält kritische Unsicherheiten und muss vor Nutzung manuell geprüft werden.';
  }
  if (confidence === 'low') {
    return 'Die Ausgabe basiert auf begrenztem Kontext und muss vor Nutzung manuell geprüft werden.';
  }
  if (warnings.length > 0) {
    return 'Die Ausgabe enthält Hinweise zu fehlendem oder unsicherem Kontext und muss geprüft werden.';
  }
  return 'Die Ausgabe ist als Entwurf gedacht und muss vor Nutzung fachlich freigegeben werden.';
};

const buildRecommendedChecks = (warnings: AiWarning[], confidence: 'low' | 'medium' | 'high'): string[] => {
  const checks = new Set<string>();
  if (confidence !== 'high') {
    checks.add('Faktenlage und Tonalität kurz manuell prüfen.');
  }
  for (const warning of warnings) {
    if (warning.code === 'MISSING_DOCUMENT_DETAILS') {
      checks.add('Prüfen, ob konkrete fehlende Unterlagen intern bekannt sind.');
    } else if (warning.code === 'NO_RESULTS_DATA') {
      checks.add('Prüfen, ob für den Bericht echte Ergebnisdaten oder manuelle Highlights ergänzt werden sollten.');
    } else if (warning.code === 'INCOMPLETE_SPEAKER_CONTEXT') {
      checks.add('Prüfen, ob für den Sprechertext weitere Fahrer- oder Klassendaten ergänzt werden sollten.');
    } else {
      checks.add('Warnhinweise vor der Übernahme inhaltlich prüfen.');
    }
  }
  return Array.from(checks);
};

const buildBlockingIssues = (warnings: AiWarning[]): string[] =>
  warnings.filter((warning) => warning.severity === 'high').map((warning) => warning.message);

const buildReplySubject = (subject: string | null | undefined) => {
  const normalized = (subject ?? '').trim();
  if (!normalized) {
    return 'Antwort auf Ihre Anfrage';
  }
  if (/^aw:\s*/i.test(normalized) || /^re:\s*/i.test(normalized)) {
    return normalized;
  }
  return `Re: ${normalized}`;
};

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

const loadApprovedKnowledgeItems = async (eventId: string | null | undefined, topics: KnowledgeTopic[]) => {
  const db = await getDb();
  const topicList = topics.length > 0 ? topics : (['general'] as KnowledgeTopic[]);
  const baseConditions = [eq(aiKnowledgeItem.status, 'approved'), inArray(aiKnowledgeItem.topic, topicList)];
  const conditions = eventId
    ? and(...baseConditions, sql`(${aiKnowledgeItem.eventId} = ${eventId} or ${aiKnowledgeItem.eventId} is null)`)
    : and(...baseConditions, sql`${aiKnowledgeItem.eventId} is null`);

  const rows = await db
    .select({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      sourceType: aiKnowledgeItem.sourceType,
      createdAt: aiKnowledgeItem.createdAt
    })
    .from(aiKnowledgeItem)
    .where(conditions)
    .orderBy(desc(aiKnowledgeItem.eventId), desc(aiKnowledgeItem.createdAt))
    .limit(8);

  return rows.map((row) => ({
    ...row,
    topic: knowledgeTopicSchema.parse(row.topic)
  }));
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

const buildReplyUnknowns = (messageText: string, approvedKnowledge: Array<{ topic: KnowledgeTopic; title: string; content: string }>) => {
  const topics = detectKnowledgeTopics(messageText);
  const unknowns: string[] = [];

  if (topics.includes('documents')) {
    unknowns.push('Welche konkreten Unterlagen oder Angaben noch fehlen, ist im System aktuell nicht strukturiert hinterlegt.');
  }
  if (topics.includes('interview') && !approvedKnowledge.some((item) => item.topic === 'interview')) {
    unknowns.push('Ob und wie Interviewanfragen nach einem Lauf gehandhabt werden, ist aktuell nicht als freigegebene Regel hinterlegt.');
  }
  return unknowns.slice(0, 8);
};

const buildConfirmedReplyFacts = (input: {
  eventName?: string | null;
  eventContactEmail?: string | null;
  registrationStatusText?: string | null;
  acceptanceStatusText?: string | null;
  paymentStatusText?: string | null;
  className?: string | null;
  vehicleLabel?: string | null;
  approvedKnowledge: Array<{ topic: KnowledgeTopic; title: string; content: string }>;
}) =>
  toCompactArray([
    input.eventName ? `Event: ${input.eventName}` : null,
    input.registrationStatusText,
    input.acceptanceStatusText,
    input.paymentStatusText,
    input.className ? `Klasse: ${input.className}` : null,
    input.vehicleLabel ? `Fahrzeug: ${input.vehicleLabel}` : null,
    ...input.approvedKnowledge.map((item) => `${item.title}: ${item.content}`)
  ], 12);

const normalizeReplyConfidence = (
  suggested: 'low' | 'medium' | 'high',
  unknowns: string[],
  warnings: AiWarning[]
): 'low' | 'medium' | 'high' => {
  if (warnings.some((warning) => warning.severity === 'high')) {
    return 'low';
  }
  if (unknowns.length >= 2) {
    return 'low';
  }
  if (unknowns.length > 0) {
    return suggested === 'high' ? 'medium' : suggested;
  }
  return suggested;
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

const buildMessageAssistantContext = async (messageId: string) => {
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
  const decodedSubject = current.subject ? decodeMimeHeaderValue(current.subject) : current.subject;
  const registrationStatusText = registrationStatusLabel(current.registrationStatus);
  const acceptanceStatusText = acceptanceStatusLabel(current.acceptanceStatus);
  const paymentStatusText = paymentStatusLabel(current.paymentStatus, amountOpenCents);
  const detectedTopics = detectKnowledgeTopics([decodedSubject, current.textContent].filter(Boolean).join('\n'));
  const approvedKnowledge = await loadApprovedKnowledgeItems(current.eventId ?? null, detectedTopics);
  const unknownFacts = buildReplyUnknowns(current.textContent, approvedKnowledge);
  const confirmedFacts = buildConfirmedReplyFacts({
    eventName: current.eventName,
    eventContactEmail: current.eventContactEmail ?? entryConfirmationConfig.organizerContactEmail,
    registrationStatusText,
    acceptanceStatusText,
    paymentStatusText,
    className: current.className,
    vehicleLabel: [current.vehicleMake, current.vehicleModel].filter(Boolean).join(' ').trim() || null,
    approvedKnowledge
  });

  return {
    current,
    assistantKnowledge,
    entryConfirmationConfig,
    recentOutgoing,
    amountOpenCents,
    paymentReference,
    decodedSubject,
    registrationStatusText,
    acceptanceStatusText,
    paymentStatusText,
    approvedKnowledge,
    unknownFacts,
    confirmedFacts
  };
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

const buildReportFactBlocks = (context: Awaited<ReturnType<typeof loadEventReportContext>> | Awaited<ReturnType<typeof loadClassReportContext>>) => {
  if (!context) {
    return [];
  }

  const blocks: Array<{ key: string; label: string; source: string; facts: string[] }> = [
    {
      key: 'event',
      label: 'Eventstammdaten',
      source: 'event',
      facts: toCompactArray([
        context.event.name,
        'startsAt' in context.event && context.event.startsAt ? `Beginn: ${context.event.startsAt}` : null,
        'endsAt' in context.event && context.event.endsAt ? `Ende: ${context.event.endsAt}` : null,
        'status' in context.event && context.event.status ? `Status: ${context.event.status}` : null,
        'contactEmail' in context.event && context.event.contactEmail ? `Kontakt: ${context.event.contactEmail}` : null,
        'websiteUrl' in context.event && context.event.websiteUrl ? `Website: ${context.event.websiteUrl}` : null
      ], 8)
    },
    {
      key: 'counts',
      label: 'Teilnahme und Zahlung',
      source: 'aggregated_counts',
      facts: [
        `Nennungen gesamt: ${context.counts.entriesTotal}`,
        `Zugelassene Nennungen: ${context.counts.acceptedTotal}`,
        `Bezahlt markiert: ${context.counts.paidTotal}`
      ]
    }
  ];

  if ('class' in context && context.class) {
    blocks.push({
      key: 'class',
      label: 'Klassenbezug',
      source: 'event_class',
      facts: [`Klasse: ${context.class.name}`]
    });
  }

  if ('classes' in context && context.classes.length > 0) {
    blocks.push({
      key: 'class_distribution',
      label: 'Klassenverteilung',
      source: 'event_class',
      facts: context.classes.map((item) => `${item.className}: ${item.count}`)
    });
  }

  return blocks.filter((block) => block.facts.length > 0);
};

const buildReportMissingData = (context: Awaited<ReturnType<typeof loadEventReportContext>> | Awaited<ReturnType<typeof loadClassReportContext>>) => {
  const missingData = [
    'Es liegen keine strukturierten Ergebnisdaten, Platzierungen oder Laufzeiten vor.'
  ];

  return missingData;
};

const buildReportSourceSummary = (input: {
  factBlocks: Array<{ key: string; label: string; source: string; facts: string[] }>;
  approvedKnowledgeCount: number;
  highlightsCount: number;
  missingDataCount: number;
  operatorInputPresent: boolean;
}) => ({
  factBlockCount: input.factBlocks.length,
  factCount: input.factBlocks.reduce((sum, block) => sum + block.facts.length, 0),
  approvedKnowledgeCount: input.approvedKnowledgeCount,
  manualHighlightsCount: input.highlightsCount,
  missingDataCount: input.missingDataCount,
  operatorInputPresent: input.operatorInputPresent
});

const normalizeReportVariantConfidence = (warnings: AiWarning[], uncertainClaims: string[]): 'low' | 'medium' | 'high' => {
  if (warnings.some((warning) => warning.severity === 'high')) {
    return 'low';
  }
  if (warnings.length > 1 || uncertainClaims.length > 0) {
    return 'medium';
  }
  return 'high';
};

const buildReportVariantReview = (
  format: ReportFormat,
  warnings: AiWarning[],
  uncertainClaims: string[]
): ReportVariantReviewPayload => ({
  format,
  confidence: normalizeReportVariantConfidence(warnings, uncertainClaims),
  blockingIssues: warnings.filter((warning) => warning.severity === 'high').map((warning) => warning.message),
  uncertainClaims: uniqueStrings(uncertainClaims, 8),
  warnings
});

const extractObjectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const extractReportDraftVariants = (outputPayload: Record<string, unknown>): ReportVariantPayload[] => {
  const items = Array.isArray(outputPayload.variants) ? outputPayload.variants : [];
  return items
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .flatMap((item) => {
      const format = item.format === 'website' || item.format === 'short_summary' ? item.format : null;
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!format || !text) {
        return [];
      }
      return [{
        format,
        title: typeof item.title === 'string' ? item.title : null,
        teaser: typeof item.teaser === 'string' ? item.teaser : null,
        text,
        highlights: Array.isArray(item.highlights) ? uniqueStrings(item.highlights.map((value) => String(value)), 10) : []
      }];
    });
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
  input: {
    tone: 'friendly' | 'neutral' | 'formal';
    includeWarnings?: boolean;
    additionalContext?: string;
    mustMention?: string[];
    mustAvoid?: string[];
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const assistantContext = await buildMessageAssistantContext(messageId);
  if (!assistantContext) {
    return null;
  }
  const {
    current,
    assistantKnowledge,
    entryConfirmationConfig,
    recentOutgoing,
    amountOpenCents,
    paymentReference,
    decodedSubject,
    registrationStatusText,
    acceptanceStatusText,
    paymentStatusText,
    approvedKnowledge,
    unknownFacts,
    confirmedFacts
  } = assistantContext;
  const context = {
    tone: input.tone,
    includeWarnings: input.includeWarnings ?? true,
    message: {
      fromEmail: current.fromEmail,
      subject: decodedSubject,
      text: current.textContent
    },
    operatorInput: {
      additionalContext: input.additionalContext ?? null,
      mustMention: input.mustMention ?? [],
      mustAvoid: input.mustAvoid ?? []
    },
    facts: {
      confirmedFacts,
      unknowns: unknownFacts
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
          acceptanceStatus: acceptanceStatusText,
          registrationStatus: registrationStatusText,
          orgaCode: current.orgaCode,
          vehicleLabel: [current.vehicleMake, current.vehicleModel].filter(Boolean).join(' ').trim() || null,
          paymentStatus: paymentStatusText,
          entryFeeCents: current.entryFeeCents,
          amountOpenCents,
          paymentRecipient: entryConfirmationConfig.paymentRecipient,
          paymentIban: entryConfirmationConfig.paymentIban,
          paymentReference,
          missingDocumentsKnown: false,
          missingDocuments: [],
          driverNote: current.driverNote,
          internalNote: current.internalNote
        }
      : null,
    previousOutgoingCommunication: recentOutgoing,
    approvedKnowledge: approvedKnowledge.map((item) => ({
      topic: item.topic,
      title: item.title,
      content: item.content
    })),
    knowledgeBase: assistantKnowledge
  };

  const generated = await generateStructuredObject({
    schema: replySuggestionSchema,
    systemPrompt: buildReplySystemPrompt(),
    userPrompt: renderJsonPrompt('summarize, categorize and draft a reply', context, {
      summary: 'string',
      category: 'zahlung|nennung|unterlagen|presse|eventlogistik|rueckfrage|sonstiges',
      replySubject: 'string',
      answerFacts: 'string[]',
      unknowns: 'string[]',
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
  const generatedUnknowns = toCompactArray([...unknownFacts, ...(generated.data.unknowns ?? [])], 8);
  const contextualWarnings = generatedUnknowns.map((unknown, index) => ({
    code: index === 0 && /unterlagen/i.test(unknown) ? 'MISSING_DOCUMENT_DETAILS' : 'UNKNOWN_CONTEXT',
    severity: 'medium' as const,
    message: unknown,
    displayMessage: unknown,
    recommendation: 'Bitte die offene Stelle vor dem Übernehmen oder Versenden kurz manuell prüfen.'
  }));
  const allWarnings = [...warnings, ...contextualWarnings];
  const effectiveConfidence = normalizeReplyConfidence(generated.data.confidence, generatedUnknowns, allWarnings);
  const reviewReason = buildReviewReason(effectiveConfidence, allWarnings);
  const recommendedChecks = buildRecommendedChecks(allWarnings, effectiveConfidence);
  const blockingIssues = buildBlockingIssues(allWarnings);
  const replySubject = generated.data.replySubject?.trim() || buildReplySubject(decodedSubject);

  return {
    messageId,
    ...withTaskEnvelope({
      task: 'reply_suggestion',
      result: {
        summary: generated.data.summary,
        category: generated.data.category,
        replySubject,
        answerFacts: uniqueStrings([...(generated.data.answerFacts ?? []), ...confirmedFacts], 8),
        unknowns: uniqueStrings(generatedUnknowns, 8),
        replyDraft: generated.data.replyDraft,
        analysis: {
          intent: generated.data.category,
          language: 'de'
        }
      },
      basis: {
        message: {
          id: messageId,
          subject: decodedSubject
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
              registrationStatusLabel: registrationStatusText,
              acceptanceStatusLabel: acceptanceStatusText,
              paymentStatusLabel: paymentStatusText,
              amountOpenCents,
              paymentReference
            }
          : null,
        knowledgeHits: buildKnowledgeHitPreview(approvedKnowledge),
        operatorInput: {
          additionalContext: input.additionalContext ?? null,
          mustMention: input.mustMention ?? [],
          mustAvoid: input.mustAvoid ?? []
        },
        usedKnowledge: {
          faqCount: assistantKnowledge.faq.length,
          logisticsNotesCount: assistantKnowledge.logisticsNotes.length,
          approvedKnowledgeCount: approvedKnowledge.length,
          previousOutgoingCount: recentOutgoing.length,
          basedOnPreviousCorrespondence: recentOutgoing.length > 0
        }
      },
      warnings: allWarnings,
      confidence: effectiveConfidence,
      modelId: generated.modelId,
      reviewReason,
      recommendedChecks,
      blockingIssues
    })
  };
};

export const generateEventReport = async (
  input: {
    eventId: string;
    classId?: string;
    scope: 'event' | 'class';
    formats: Array<ReportFormat>;
    tone: 'neutral' | 'friendly' | 'formal';
    length: 'short' | 'medium' | 'long';
    highlights?: string[];
    additionalContext?: string;
    mustMention?: string[];
    mustAvoid?: string[];
    audience?: string;
    publishChannel?: string;
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
  const approvedKnowledge = await loadApprovedKnowledgeItems(input.eventId, ['general', 'logistics', 'contact']);
  const factBlocks = buildReportFactBlocks(context);
  const missingData = buildReportMissingData(context);
  const operatorInput = {
    additionalContext: input.additionalContext ?? null,
    mustMention: input.mustMention ?? [],
    mustAvoid: input.mustAvoid ?? [],
    audience: input.audience ?? null,
    publishChannel: input.publishChannel ?? null
  };

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
            highlights: input.highlights ?? [],
            factBlocks,
            approvedKnowledge: approvedKnowledge.map((item) => ({
              topic: item.topic,
              title: item.title,
              content: item.content
            })),
            operatorInput,
            missingData
          },
          {
            title: 'string?',
            teaser: 'string|null',
            text: 'string',
            warnings: 'string[]',
            uncertainClaims: 'string[]'
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
      message: 'Es liegen keine strukturierten Ergebnisdaten vor; der Text basiert auf Stammdaten und manuellen Highlights.',
      displayMessage: 'Der Bericht basiert derzeit auf Stammdaten und manuellen Highlights, nicht auf Ergebnisdaten.',
      recommendation: 'Für belastbarere Berichtstexte später strukturierte Ergebnisdaten anbinden.'
    }
  ];
  const confidence = warnings.length > 1 ? 'medium' : 'high';
  const variantReview = variants.map((variant) =>
    buildReportVariantReview(
      variant.format,
      normalizeWarnings(variant.generated.data.warnings ?? [], 'REVIEW_NOTE'),
      variant.generated.data.uncertainClaims ?? []
    )
  );

  return {
    eventId: input.eventId,
    ...withTaskEnvelope({
      task: 'event_report',
      result: {
        variants: variants.map((variant) => ({
          format: variant.format,
          title: variant.generated.data.title ?? null,
          teaser: variant.generated.data.teaser ?? null,
          text: variant.generated.data.text,
          highlights: input.highlights ?? []
        })),
        variantReview,
        blockingIssues: uniqueStrings(variantReview.flatMap((item) => item.blockingIssues), 8),
        uncertainClaims: uniqueStrings(variantReview.flatMap((item) => item.uncertainClaims), 8)
      },
      basis: {
        scope: input.scope,
        event: context.event,
        class: 'class' in context ? context.class : null,
        facts: context.counts,
        highlights: input.highlights ?? [],
        factBlocks,
        usedKnowledge: buildKnowledgeHitPreview(approvedKnowledge),
        operatorInput,
        sourceSummary: buildReportSourceSummary({
          factBlocks,
          approvedKnowledgeCount: approvedKnowledge.length,
          highlightsCount: (input.highlights ?? []).length,
          missingDataCount: missingData.length,
          operatorInputPresent: Boolean(
            operatorInput.additionalContext ||
            operatorInput.mustMention.length > 0 ||
            operatorInput.mustAvoid.length > 0 ||
            operatorInput.audience ||
            operatorInput.publishChannel
          )
        }),
        missingData
      },
      warnings,
      confidence,
      modelId: variants[0]?.generated.modelId ?? 'unknown',
      reviewReason: buildReviewReason(confidence, warnings),
      recommendedChecks: buildRecommendedChecks(warnings, confidence),
      blockingIssues: buildBlockingIssues(warnings)
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

  const normalizedWarnings = normalizeWarnings(generated.data.warnings ?? [], 'INCOMPLETE_SPEAKER_CONTEXT');
  const confidence = (generated.data.warnings ?? []).length > 0 ? 'medium' : 'high';
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
      warnings: normalizedWarnings,
      confidence,
      modelId: generated.modelId,
      reviewReason: buildReviewReason(confidence, normalizedWarnings),
      recommendedChecks: buildRecommendedChecks(normalizedWarnings, confidence),
      blockingIssues: buildBlockingIssues(normalizedWarnings)
    })
  };
};

export const generateMessageChat = async (
  messageId: string,
  input: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; message: string }>;
    contextMode?: 'reply' | 'knowledge_capture';
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const assistantContext = await buildMessageAssistantContext(messageId);
  if (!assistantContext) {
    return null;
  }

  const {
    current,
    decodedSubject,
    approvedKnowledge,
    confirmedFacts,
    unknownFacts,
    registrationStatusText,
    acceptanceStatusText,
    paymentStatusText
  } = assistantContext;
  const contextMode = input.contextMode ?? 'reply';

  const generated = await generateStructuredObject({
    schema: messageChatSchema,
    systemPrompt: buildChatSystemPrompt(contextMode),
    userPrompt: renderJsonPrompt(
      'answer a follow-up question for the current message and optionally extract reusable knowledge',
      {
        contextMode,
        message: {
          id: messageId,
          subject: decodedSubject,
          text: current.textContent
        },
        operatorMessage: input.message,
        history: (input.history ?? []).map((item) => ({
          role: item.role,
          message: item.message
        })),
        confirmedFacts,
        unknowns: unknownFacts,
        event: current.eventId
          ? {
              id: current.eventId,
              name: current.eventName,
              contactEmail: current.eventContactEmail
            }
          : null,
        entry: current.entryId
          ? {
              id: current.entryId,
              registrationStatus: registrationStatusText,
              acceptanceStatus: acceptanceStatusText,
              paymentStatus: paymentStatusText,
              className: current.className
            }
          : null,
        approvedKnowledge: approvedKnowledge.map((item) => ({
          topic: item.topic,
          title: item.title,
          content: item.content
        }))
      },
      {
        answer: 'string',
        usedFacts: 'string[]',
        unknowns: 'string[]',
        knowledgeSuggestions: 'array'
      }
    ),
    maxTokens: 900
  });

  const generatedSuggestions = normalizeKnowledgeSuggestions(generated.data.knowledgeSuggestions, contextMode === 'knowledge_capture' ? 'general' : undefined);
  const fallbackSuggestions =
    generatedSuggestions.length === 0 && contextMode === 'knowledge_capture'
      ? buildFallbackKnowledgeSuggestions({
          messageText: current.textContent,
          history: input.history,
          topicHint: undefined,
          approvedKnowledge
        })
      : [];
  const validatedSuggestions = generatedSuggestions.length > 0 ? generatedSuggestions : fallbackSuggestions;
  const allUnknowns = uniqueStrings([...unknownFacts, ...(generated.data.unknowns ?? [])], 8);
  const warnings = allUnknowns.map((unknown) => ({
    code: 'UNKNOWN_CONTEXT',
    severity: 'medium' as const,
    message: unknown,
    displayMessage: unknown,
    recommendation: 'Falls die Information wichtig fuer die Antwort ist, bitte vor der Uebernahme manuell ergaenzen oder pruefen.'
  }));
  const confidence = normalizeReplyConfidence('medium', allUnknowns, warnings);

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'ai_message_chat_generated',
    entityType: 'ai_message_source',
    entityId: messageId as never,
    payload: {
      messageId,
      contextMode,
      suggestionCount: validatedSuggestions.length
    }
  });

  return {
    messageId,
    ...withTaskEnvelope({
      task: 'message_chat',
      result: {
        answer: generated.data.answer,
        usedFacts: uniqueStrings([...(generated.data.usedFacts ?? []), ...confirmedFacts], 10),
        unknowns: allUnknowns,
        knowledgeSuggestions: validatedSuggestions
      },
      basis: {
        message: {
          id: messageId,
          subject: decodedSubject
        },
        knowledgeHits: buildKnowledgeHitPreview(approvedKnowledge),
        historyCount: input.history?.length ?? 0,
        contextMode
      },
      warnings,
      confidence,
      modelId: generated.modelId,
      reviewReason: buildReviewReason(confidence, warnings),
      recommendedChecks: buildRecommendedChecks(warnings, confidence),
      blockingIssues: buildBlockingIssues(warnings)
    })
  };
};

export const generateKnowledgeSuggestionsForMessage = async (
  messageId: string,
  input: {
    additionalContext?: string;
    history?: Array<{ role: 'user' | 'assistant'; message: string }>;
    topicHint?: KnowledgeTopic;
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const assistantContext = await buildMessageAssistantContext(messageId);
  if (!assistantContext) {
    return null;
  }

  const {
    current,
    decodedSubject,
    approvedKnowledge,
    confirmedFacts,
    unknownFacts
  } = assistantContext;

  const generated = await generateStructuredObject({
    schema: z.object({
      suggestions: z.array(looseKnowledgeSuggestionSchema).max(8).default([]),
      warnings: z.array(z.string()).max(8).default([])
    }),
    systemPrompt:
      'You create reusable, review-required knowledge suggestions for an event operations team. Return only facts that are suitable for reuse in later replies. Answer in German and return JSON with suggestions and warnings.',
    userPrompt: renderJsonPrompt(
      'extract reusable knowledge suggestions from the message context and operator additions',
      {
        topicHint: input.topicHint ?? null,
        message: {
          id: messageId,
          subject: decodedSubject,
          text: current.textContent
        },
        operatorInput: input.additionalContext ?? null,
        history: input.history ?? [],
        confirmedFacts,
        unknowns: unknownFacts,
        existingApprovedKnowledge: approvedKnowledge.map((item) => ({
          topic: item.topic,
          title: item.title,
          content: item.content
        }))
      },
      {
        suggestions: 'array',
        warnings: 'string[]'
      }
    ),
    maxTokens: 900
  });

  const now = new Date();
  const generatedSuggestions = normalizeKnowledgeSuggestions(generated.data.suggestions, input.topicHint);
  const fallbackSuggestions =
    generatedSuggestions.length === 0
      ? buildFallbackKnowledgeSuggestions({
          messageText: current.textContent,
          additionalContext: input.additionalContext,
          history: input.history,
          topicHint: input.topicHint,
          approvedKnowledge
        })
      : [];
  const normalizedSuggestions = generatedSuggestions.length > 0 ? generatedSuggestions : fallbackSuggestions;
  const preparedSuggestions = normalizedSuggestions.map((item) => ({
    eventId: current.eventId ?? null,
    messageId,
    topic: item.topic,
    title: item.title,
    content: item.content,
    rationale: item.rationale ?? null,
    status: 'suggested' as const,
    sourceType: 'ai_suggested' as const,
    createdBy: actorUserId,
    metadata: {
      topicHint: input.topicHint ?? null,
      additionalContextProvided: Boolean(input.additionalContext),
      historyCount: input.history?.length ?? 0
    },
    createdAt: now,
    updatedAt: now
  }));

  const createdRows =
    preparedSuggestions.length > 0
      ? await db
          .insert(aiKnowledgeSuggestion)
          .values(preparedSuggestions)
          .returning({
            id: aiKnowledgeSuggestion.id,
            eventId: aiKnowledgeSuggestion.eventId,
            messageId: aiKnowledgeSuggestion.messageId,
            topic: aiKnowledgeSuggestion.topic,
            title: aiKnowledgeSuggestion.title,
            content: aiKnowledgeSuggestion.content,
            rationale: aiKnowledgeSuggestion.rationale,
            status: aiKnowledgeSuggestion.status,
            createdAt: aiKnowledgeSuggestion.createdAt
          })
      : [];

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'ai_knowledge_suggestions_generated',
    entityType: 'ai_message_source',
    entityId: messageId as never,
    payload: {
      messageId,
      suggestionCount: createdRows.length,
      topicHint: input.topicHint ?? null
    }
  });

  const warnings = normalizeWarnings(generated.data.warnings ?? [], 'REVIEW_NOTE');
  const confidence = createdRows.length > 0 ? 'medium' : 'low';

  return {
    messageId,
    ...withTaskEnvelope({
      task: 'knowledge_suggestions',
      result: {
        suggestions: createdRows.map((item) => ({
          ...item,
          topic: knowledgeTopicSchema.parse(item.topic)
        }))
      },
      basis: {
        message: {
          id: messageId,
          subject: decodedSubject
        },
        approvedKnowledge: buildKnowledgeHitPreview(approvedKnowledge),
        operatorInput: input.additionalContext ?? null,
        historyCount: input.history?.length ?? 0
      },
      warnings,
      confidence,
      modelId: generated.modelId,
      reviewReason: buildReviewReason(confidence, warnings),
      recommendedChecks: buildRecommendedChecks(warnings, confidence),
      blockingIssues: buildBlockingIssues(warnings)
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

export const getGeneratedDraft = async (draftId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiDraft.id,
      taskType: aiDraft.taskType,
      status: aiDraft.status,
      eventId: aiDraft.eventId,
      entryId: aiDraft.entryId,
      messageId: aiDraft.messageId,
      title: aiDraft.title,
      promptVersion: aiDraft.promptVersion,
      modelId: aiDraft.modelId,
      inputSnapshot: aiDraft.inputSnapshot,
      outputPayload: aiDraft.outputPayload,
      warnings: aiDraft.warnings,
      createdBy: aiDraft.createdBy,
      createdAt: aiDraft.createdAt,
      updatedAt: aiDraft.updatedAt
    })
    .from(aiDraft)
    .where(eq(aiDraft.id, draftId))
    .limit(1);

  return rows[0] ?? null;
};

export const updateReplyDraft = async (
  draftId: string,
  input:
    | {
        replySubject: string;
        replyDraft: string;
        answerFacts: string[];
        unknowns: string[];
        operatorEdits?: Record<string, unknown>;
      }
    | {
        variants: Array<{
          format: ReportFormat;
          title?: string | null;
          teaser?: string | null;
          text: string;
          highlights?: string[];
        }>;
        highlights?: string[];
        operatorEdits?: Record<string, unknown>;
      },
  actorUserId: string | null
) => {
  const db = await getDb();
  const current = await getGeneratedDraft(draftId);
  if (!current) {
    return null;
  }

  const now = new Date();
  const outputPayload = ((current.outputPayload ?? {}) as Record<string, unknown>) || {};
  const existingOperatorEdits =
    outputPayload.operatorEdits && typeof outputPayload.operatorEdits === 'object' && !Array.isArray(outputPayload.operatorEdits)
      ? (outputPayload.operatorEdits as Record<string, unknown>)
      : {};
  let updatedOutputPayload: Record<string, unknown>;

  if (current.taskType === 'reply_suggestion') {
    if (!('replySubject' in input)) {
      throw new Error('AI_DRAFT_INVALID_PATCH_PAYLOAD');
    }
    updatedOutputPayload = {
      ...outputPayload,
      replySubject: input.replySubject,
      replyDraft: input.replyDraft,
      answerFacts: uniqueStrings(input.answerFacts, 12),
      unknowns: uniqueStrings(input.unknowns, 12),
      operatorEdits: {
        ...existingOperatorEdits,
        ...(input.operatorEdits ?? {}),
        editedBy: actorUserId,
        editedAt: now.toISOString()
      },
      editedBy: actorUserId,
      editedAt: now.toISOString()
    };
  } else if (current.taskType === 'event_report') {
    if (!('variants' in input)) {
      throw new Error('AI_DRAFT_INVALID_PATCH_PAYLOAD');
    }
    updatedOutputPayload = {
      ...outputPayload,
      variants: input.variants.map((variant) => ({
        format: variant.format,
        title: variant.title ?? null,
        teaser: variant.teaser ?? null,
        text: variant.text,
        highlights: uniqueStrings([...(variant.highlights ?? []), ...(input.highlights ?? [])], 10)
      })),
      highlights: uniqueStrings(input.highlights ?? [], 10),
      operatorEdits: {
        ...existingOperatorEdits,
        ...(input.operatorEdits ?? {}),
        editedBy: actorUserId,
        editedAt: now.toISOString()
      },
      editedBy: actorUserId,
      editedAt: now.toISOString()
    };
  } else {
    throw new Error('AI_DRAFT_NOT_PATCHABLE');
  }

  const [updated] = await db
    .update(aiDraft)
    .set({
      outputPayload: updatedOutputPayload,
      updatedAt: now
    })
    .where(eq(aiDraft.id, draftId))
    .returning({
      id: aiDraft.id,
      taskType: aiDraft.taskType,
      status: aiDraft.status,
      eventId: aiDraft.eventId,
      entryId: aiDraft.entryId,
      messageId: aiDraft.messageId,
      title: aiDraft.title,
      promptVersion: aiDraft.promptVersion,
      modelId: aiDraft.modelId,
      inputSnapshot: aiDraft.inputSnapshot,
      outputPayload: aiDraft.outputPayload,
      warnings: aiDraft.warnings,
      createdBy: aiDraft.createdBy,
      createdAt: aiDraft.createdAt,
      updatedAt: aiDraft.updatedAt
    });

  if (!updated) {
    throw new Error('AI_DRAFT_UPDATE_FAILED');
  }

  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'ai_draft_updated',
    entityType: 'ai_draft',
    entityId: updated.id as never,
    payload: {
      draftId: updated.id,
      taskType: updated.taskType,
      messageId: updated.messageId
    }
  });

  return updated;
};

export const regenerateEventReportVariant = async (
  draftId: string,
  input: {
    format: ReportFormat;
    additionalContext?: string;
    mustMention?: string[];
    mustAvoid?: string[];
    audience?: string;
    publishChannel?: string;
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const current = await getGeneratedDraft(draftId);
  if (!current) {
    return null;
  }
  if (current.taskType !== 'event_report') {
    throw new Error('AI_DRAFT_NOT_EVENT_REPORT');
  }

  const snapshot = extractObjectRecord(current.inputSnapshot);
  const eventId = typeof snapshot.eventId === 'string' ? snapshot.eventId : current.eventId;
  const scope = snapshot.scope === 'class' ? 'class' : 'event';
  const classId = typeof snapshot.classId === 'string' ? snapshot.classId : undefined;
  const tone = snapshot.tone === 'friendly' || snapshot.tone === 'formal' ? snapshot.tone : 'neutral';
  const length = snapshot.length === 'short' || snapshot.length === 'long' ? snapshot.length : 'medium';
  const highlights = Array.isArray(snapshot.highlights) ? uniqueStrings(snapshot.highlights.map((value) => String(value)), 10) : [];

  if (!eventId) {
    throw new Error('AI_DRAFT_EVENT_CONTEXT_MISSING');
  }

  const generated = await generateEventReport({
    eventId,
    classId,
    scope,
    formats: [input.format],
    tone,
    length,
    highlights,
    additionalContext: input.additionalContext ?? (typeof snapshot.additionalContext === 'string' ? snapshot.additionalContext : undefined),
    mustMention: input.mustMention ?? (Array.isArray(snapshot.mustMention) ? snapshot.mustMention.map((value) => String(value)) : []),
    mustAvoid: input.mustAvoid ?? (Array.isArray(snapshot.mustAvoid) ? snapshot.mustAvoid.map((value) => String(value)) : []),
    audience: input.audience ?? (typeof snapshot.audience === 'string' ? snapshot.audience : undefined),
    publishChannel: input.publishChannel ?? (typeof snapshot.publishChannel === 'string' ? snapshot.publishChannel : undefined)
  }, actorUserId);

  if (!generated) {
    return null;
  }

  const now = new Date();
  const outputPayload = extractObjectRecord(current.outputPayload);
  const currentVariants = extractReportDraftVariants(outputPayload).filter((variant) => variant.format !== input.format);
  const regeneratedVariant = (generated.result.variants as ReportVariantPayload[])[0];
  const currentVariantReview = Array.isArray(outputPayload.variantReview) ? outputPayload.variantReview.filter((item) => {
    const record = extractObjectRecord(item);
    return record.format !== input.format;
  }) : [];
  const regeneratedVariantReview = (generated.result.variantReview as ReportVariantReviewPayload[])[0];

  const updatedOutputPayload = {
    ...outputPayload,
    variants: [...currentVariants, regeneratedVariant].sort((a, b) => a.format.localeCompare(b.format)),
    variantReview: [...currentVariantReview, regeneratedVariantReview].sort((a, b) => String(extractObjectRecord(a).format).localeCompare(String(extractObjectRecord(b).format))),
    blockingIssues: generated.result.blockingIssues,
    uncertainClaims: generated.result.uncertainClaims,
    basis: generated.basis,
    review: generated.review,
    meta: generated.meta,
    operatorEdits: {
      ...extractObjectRecord(outputPayload.operatorEdits),
      editedBy: actorUserId,
      editedAt: now.toISOString(),
      regeneratedFormat: input.format
    },
    editedBy: actorUserId,
    editedAt: now.toISOString()
  };

  const [updated] = await db
    .update(aiDraft)
    .set({
      outputPayload: updatedOutputPayload,
      warnings: generated.warnings,
      modelId: generated.meta.modelId,
      promptVersion: generated.meta.promptVersion,
      updatedAt: now
    })
    .where(eq(aiDraft.id, draftId))
    .returning({
      id: aiDraft.id,
      taskType: aiDraft.taskType,
      status: aiDraft.status,
      eventId: aiDraft.eventId,
      entryId: aiDraft.entryId,
      messageId: aiDraft.messageId,
      title: aiDraft.title,
      promptVersion: aiDraft.promptVersion,
      modelId: aiDraft.modelId,
      inputSnapshot: aiDraft.inputSnapshot,
      outputPayload: aiDraft.outputPayload,
      warnings: aiDraft.warnings,
      createdBy: aiDraft.createdBy,
      createdAt: aiDraft.createdAt,
      updatedAt: aiDraft.updatedAt
    });

  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'ai_report_variant_regenerated',
    entityType: 'ai_draft',
    entityId: updated.id as never,
    payload: {
      draftId: updated.id,
      format: input.format,
      eventId: updated.eventId
    }
  });

  return {
    draft: updated,
    generated
  };
};

export const listKnowledgeSuggestions = async (query: {
  eventId?: string;
  messageId?: string;
  topic?: KnowledgeTopic;
  status?: 'suggested' | 'approved' | 'rejected' | 'archived';
  limit?: number;
}) => {
  const db = await getDb();
  const conditions = [];
  if (query.eventId) {
    conditions.push(eq(aiKnowledgeSuggestion.eventId, query.eventId));
  }
  if (query.messageId) {
    conditions.push(eq(aiKnowledgeSuggestion.messageId, query.messageId));
  }
  if (query.topic) {
    conditions.push(eq(aiKnowledgeSuggestion.topic, query.topic));
  }
  if (query.status) {
    conditions.push(eq(aiKnowledgeSuggestion.status, query.status));
  }

  const rows = await db
    .select({
      id: aiKnowledgeSuggestion.id,
      eventId: aiKnowledgeSuggestion.eventId,
      messageId: aiKnowledgeSuggestion.messageId,
      topic: aiKnowledgeSuggestion.topic,
      title: aiKnowledgeSuggestion.title,
      content: aiKnowledgeSuggestion.content,
      rationale: aiKnowledgeSuggestion.rationale,
      status: aiKnowledgeSuggestion.status,
      sourceType: aiKnowledgeSuggestion.sourceType,
      createdAt: aiKnowledgeSuggestion.createdAt,
      updatedAt: aiKnowledgeSuggestion.updatedAt
    })
    .from(aiKnowledgeSuggestion)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(aiKnowledgeSuggestion.createdAt))
    .limit(query.limit ?? 20);

  return rows.map((row) => ({
    ...row,
    topic: knowledgeTopicSchema.parse(row.topic)
  }));
};

export const generateKnowledgeSuggestionsForReportDraft = async (
  draftId: string,
  input: {
    additionalContext?: string;
    topicHint?: KnowledgeTopic;
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const current = await getGeneratedDraft(draftId);
  if (!current) {
    return null;
  }
  if (current.taskType !== 'event_report') {
    throw new Error('AI_DRAFT_NOT_EVENT_REPORT');
  }

  const outputPayload = extractObjectRecord(current.outputPayload);
  const basis = extractObjectRecord(outputPayload.basis);
  const approvedKnowledge = (Array.isArray(basis.usedKnowledge) ? basis.usedKnowledge : [])
    .map((item) => extractObjectRecord(item))
    .flatMap((item) => {
      const topic = typeof item.topic === 'string' ? knowledgeTopicSchema.safeParse(item.topic).data : undefined;
      const title = typeof item.title === 'string' ? item.title : undefined;
      const content = typeof item.content === 'string' ? item.content : undefined;
      const id = typeof item.id === 'string' ? item.id : undefined;
      return topic && title && content ? [{ id, topic, title, content }] : [];
    });
  const factBlocks = Array.isArray(basis.factBlocks) ? basis.factBlocks : [];
  const highlights = Array.isArray(outputPayload.highlights)
    ? outputPayload.highlights.map((value) => String(value))
    : Array.isArray(basis.highlights)
      ? basis.highlights.map((value) => String(value))
      : [];
  const candidateText = [
    ...factBlocks.flatMap((item) => {
      const block = extractObjectRecord(item);
      const label = typeof block.label === 'string' ? block.label : 'Berichtsfakten';
      const facts = Array.isArray(block.facts) ? block.facts.map((value) => String(value)) : [];
      return facts.map((fact) => `${label}: ${fact}`);
    }),
    ...highlights,
    input.additionalContext ?? ''
  ].join('\n\n');

  const normalized = buildFallbackKnowledgeSuggestions({
    messageText: candidateText,
    additionalContext: candidateText,
    topicHint: input.topicHint,
    approvedKnowledge: approvedKnowledge.map((item) => ({
      topic: item.topic,
      title: item.title,
      content: item.content
    }))
  });

  const now = new Date();
  const createdRows =
    normalized.length > 0
      ? await db
          .insert(aiKnowledgeSuggestion)
          .values(
            normalized.map((item) => ({
              eventId: current.eventId ?? null,
              messageId: null,
              topic: item.topic,
              title: item.title,
              content: item.content,
              rationale: item.rationale ?? 'Aus bestaetigten Berichtsfakten und Operator-Eingaben abgeleitet.',
              status: 'suggested',
              sourceType: 'ai_suggested',
              createdBy: actorUserId,
              createdAt: now,
              updatedAt: now
            }))
          )
          .returning({
            id: aiKnowledgeSuggestion.id,
            eventId: aiKnowledgeSuggestion.eventId,
            messageId: aiKnowledgeSuggestion.messageId,
            topic: aiKnowledgeSuggestion.topic,
            title: aiKnowledgeSuggestion.title,
            content: aiKnowledgeSuggestion.content,
            rationale: aiKnowledgeSuggestion.rationale,
            status: aiKnowledgeSuggestion.status,
            createdAt: aiKnowledgeSuggestion.createdAt
          })
      : [];

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'ai_report_knowledge_suggestions_generated',
    entityType: 'ai_draft',
    entityId: draftId as never,
    payload: {
      draftId,
      suggestionCount: createdRows.length,
      eventId: current.eventId
    }
  });

  return {
    draftId,
    ...withTaskEnvelope({
      task: 'knowledge_suggestions',
      result: {
        suggestions: createdRows.map((item) => ({
          ...item,
          topic: knowledgeTopicSchema.parse(item.topic)
        }))
      },
      basis: {
        draftId,
        eventId: current.eventId,
        factBlockCount: factBlocks.length,
        approvedKnowledge: approvedKnowledge.map((item) => ({
          id: item.id ?? null,
          topic: item.topic,
          title: item.title,
          content: item.content
        })),
        operatorInput: input.additionalContext ?? null
      },
      warnings: [],
      confidence: createdRows.length > 0 ? 'medium' : 'low',
      modelId: current.modelId ?? 'manual-fallback',
      reviewReason: 'Wissensvorschlaege aus Berichtsfakten muessen vor der Uebernahme manuell geprueft werden.',
      recommendedChecks: ['Titel, Inhalt und Themenzuordnung der Wissensvorschlaege manuell pruefen.'],
      blockingIssues: []
    })
  };
};

export const createKnowledgeItem = async (
  input: {
    suggestionId?: string;
    eventId?: string;
    messageId?: string;
    topic?: KnowledgeTopic;
    title?: string;
    content?: string;
    status?: 'suggested' | 'approved' | 'archived';
    metadata?: Record<string, unknown>;
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();

  let suggestion:
    | {
        id: string;
        eventId: string | null;
        messageId: string | null;
        topic: string;
        title: string;
        content: string;
      }
    | null = null;

  if (input.suggestionId) {
    const rows = await db
      .select({
        id: aiKnowledgeSuggestion.id,
        eventId: aiKnowledgeSuggestion.eventId,
        messageId: aiKnowledgeSuggestion.messageId,
        topic: aiKnowledgeSuggestion.topic,
        title: aiKnowledgeSuggestion.title,
        content: aiKnowledgeSuggestion.content
      })
      .from(aiKnowledgeSuggestion)
      .where(eq(aiKnowledgeSuggestion.id, input.suggestionId))
      .limit(1);
    suggestion = rows[0] ?? null;
    if (!suggestion) {
      return null;
    }
  }

  const topic = input.topic ?? (suggestion ? knowledgeTopicSchema.parse(suggestion.topic) : undefined);
  const title = input.title ?? suggestion?.title;
  const content = input.content ?? suggestion?.content;

  if (!topic || !title || !content) {
    throw new Error('AI_KNOWLEDGE_ITEM_INVALID');
  }

  const [created] = await db
    .insert(aiKnowledgeItem)
    .values({
      eventId: input.eventId ?? suggestion?.eventId ?? null,
      messageId: input.messageId ?? suggestion?.messageId ?? null,
      suggestionId: input.suggestionId ?? null,
      topic,
      title,
      content,
      status: input.status ?? 'approved',
      sourceType: input.suggestionId ? 'ai_suggested' : 'manual',
      createdBy: actorUserId,
      approvedBy: actorUserId,
      approvedAt: input.status === 'suggested' ? null : now,
      updatedBy: actorUserId,
      archivedBy: input.status === 'archived' ? actorUserId : null,
      archivedAt: input.status === 'archived' ? now : null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    })
    .returning({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      messageId: aiKnowledgeItem.messageId,
      suggestionId: aiKnowledgeItem.suggestionId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      status: aiKnowledgeItem.status,
      sourceType: aiKnowledgeItem.sourceType,
      updatedBy: aiKnowledgeItem.updatedBy,
      archivedBy: aiKnowledgeItem.archivedBy,
      archivedAt: aiKnowledgeItem.archivedAt,
      createdAt: aiKnowledgeItem.createdAt
    });

  if (!created) {
    throw new Error('AI_KNOWLEDGE_ITEM_SAVE_FAILED');
  }

  if (input.suggestionId) {
    await db
      .update(aiKnowledgeSuggestion)
      .set({
        status: 'approved',
        reviewedBy: actorUserId,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(aiKnowledgeSuggestion.id, input.suggestionId));
  }

  await writeAuditLog(db as never, {
    eventId: created.eventId,
    actorUserId,
    action: 'ai_knowledge_item_saved',
    entityType: 'ai_knowledge_item',
    entityId: created.id as never,
    payload: {
      knowledgeItemId: created.id,
      suggestionId: input.suggestionId ?? null,
      topic,
      status: created.status
    }
  });

  return {
    ...created,
    topic: knowledgeTopicSchema.parse(created.topic)
  };
};

export const getKnowledgeItem = async (knowledgeItemId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      messageId: aiKnowledgeItem.messageId,
      suggestionId: aiKnowledgeItem.suggestionId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      status: aiKnowledgeItem.status,
      sourceType: aiKnowledgeItem.sourceType,
      createdBy: aiKnowledgeItem.createdBy,
      approvedBy: aiKnowledgeItem.approvedBy,
      approvedAt: aiKnowledgeItem.approvedAt,
      updatedBy: aiKnowledgeItem.updatedBy,
      archivedBy: aiKnowledgeItem.archivedBy,
      archivedAt: aiKnowledgeItem.archivedAt,
      metadata: aiKnowledgeItem.metadata,
      createdAt: aiKnowledgeItem.createdAt,
      updatedAt: aiKnowledgeItem.updatedAt
    })
    .from(aiKnowledgeItem)
    .where(eq(aiKnowledgeItem.id, knowledgeItemId))
    .limit(1);

  const current = rows[0];
  if (!current) {
    return null;
  }

  return {
    ...current,
    topic: knowledgeTopicSchema.parse(current.topic)
  };
};

export const updateKnowledgeItem = async (
  knowledgeItemId: string,
  input: {
    topic: KnowledgeTopic;
    title: string;
    content: string;
    status: 'suggested' | 'approved' | 'archived';
  },
  actorUserId: string | null
) => {
  const db = await getDb();
  const current = await getKnowledgeItem(knowledgeItemId);
  if (!current) {
    return null;
  }

  const now = new Date();
  const isArchived = input.status === 'archived';
  const [updated] = await db
    .update(aiKnowledgeItem)
    .set({
      topic: input.topic,
      title: input.title,
      content: input.content,
      status: input.status,
      updatedBy: actorUserId,
      updatedAt: now,
      archivedBy: isArchived ? actorUserId : null,
      archivedAt: isArchived ? now : null,
      approvedBy: input.status === 'approved' ? actorUserId : current.approvedBy,
      approvedAt: input.status === 'approved' ? (current.approvedAt ?? now) : current.approvedAt
    })
    .where(eq(aiKnowledgeItem.id, knowledgeItemId))
    .returning({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      messageId: aiKnowledgeItem.messageId,
      suggestionId: aiKnowledgeItem.suggestionId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      status: aiKnowledgeItem.status,
      sourceType: aiKnowledgeItem.sourceType,
      createdBy: aiKnowledgeItem.createdBy,
      approvedBy: aiKnowledgeItem.approvedBy,
      approvedAt: aiKnowledgeItem.approvedAt,
      updatedBy: aiKnowledgeItem.updatedBy,
      archivedBy: aiKnowledgeItem.archivedBy,
      archivedAt: aiKnowledgeItem.archivedAt,
      metadata: aiKnowledgeItem.metadata,
      createdAt: aiKnowledgeItem.createdAt,
      updatedAt: aiKnowledgeItem.updatedAt
    });

  if (!updated) {
    throw new Error('AI_KNOWLEDGE_ITEM_UPDATE_FAILED');
  }

  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'ai_knowledge_item_updated',
    entityType: 'ai_knowledge_item',
    entityId: updated.id as never,
    payload: {
      knowledgeItemId: updated.id,
      topic: updated.topic,
      status: updated.status
    }
  });

  return {
    ...updated,
    topic: knowledgeTopicSchema.parse(updated.topic)
  };
};

export const archiveKnowledgeItem = async (knowledgeItemId: string, actorUserId: string | null) => {
  const db = await getDb();
  const current = await getKnowledgeItem(knowledgeItemId);
  if (!current) {
    return null;
  }

  const now = new Date();
  const [updated] = await db
    .update(aiKnowledgeItem)
    .set({
      status: 'archived',
      updatedBy: actorUserId,
      archivedBy: actorUserId,
      archivedAt: now,
      updatedAt: now
    })
    .where(eq(aiKnowledgeItem.id, knowledgeItemId))
    .returning({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      messageId: aiKnowledgeItem.messageId,
      suggestionId: aiKnowledgeItem.suggestionId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      status: aiKnowledgeItem.status,
      sourceType: aiKnowledgeItem.sourceType,
      createdBy: aiKnowledgeItem.createdBy,
      approvedBy: aiKnowledgeItem.approvedBy,
      approvedAt: aiKnowledgeItem.approvedAt,
      updatedBy: aiKnowledgeItem.updatedBy,
      archivedBy: aiKnowledgeItem.archivedBy,
      archivedAt: aiKnowledgeItem.archivedAt,
      metadata: aiKnowledgeItem.metadata,
      createdAt: aiKnowledgeItem.createdAt,
      updatedAt: aiKnowledgeItem.updatedAt
    });

  if (!updated) {
    throw new Error('AI_KNOWLEDGE_ITEM_ARCHIVE_FAILED');
  }

  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'ai_knowledge_item_archived',
    entityType: 'ai_knowledge_item',
    entityId: updated.id as never,
    payload: {
      knowledgeItemId: updated.id,
      status: updated.status
    }
  });

  return {
    ...updated,
    topic: knowledgeTopicSchema.parse(updated.topic)
  };
};

export const listKnowledgeItems = async (query: {
  eventId?: string;
  topic?: KnowledgeTopic;
  status?: 'suggested' | 'approved' | 'archived';
  limit?: number;
}) => {
  const db = await getDb();
  const conditions = [];
  if (query.eventId) {
    conditions.push(eq(aiKnowledgeItem.eventId, query.eventId));
  }
  if (query.topic) {
    conditions.push(eq(aiKnowledgeItem.topic, query.topic));
  }
  if (query.status) {
    conditions.push(eq(aiKnowledgeItem.status, query.status));
  }

  const rows = await db
    .select({
      id: aiKnowledgeItem.id,
      eventId: aiKnowledgeItem.eventId,
      messageId: aiKnowledgeItem.messageId,
      suggestionId: aiKnowledgeItem.suggestionId,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content,
      status: aiKnowledgeItem.status,
      sourceType: aiKnowledgeItem.sourceType,
      updatedBy: aiKnowledgeItem.updatedBy,
      archivedBy: aiKnowledgeItem.archivedBy,
      archivedAt: aiKnowledgeItem.archivedAt,
      createdAt: aiKnowledgeItem.createdAt,
      updatedAt: aiKnowledgeItem.updatedAt
    })
    .from(aiKnowledgeItem)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(aiKnowledgeItem.createdAt))
    .limit(query.limit ?? 20);

  return rows.map((row) => ({
    ...row,
    topic: knowledgeTopicSchema.parse(row.topic)
  }));
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
