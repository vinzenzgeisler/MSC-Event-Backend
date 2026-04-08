import { z } from 'zod';
import { generateStructuredObject } from './bedrock';
import { KnowledgeItem } from './knowledge';
import { AiWarning, normalizeWarnings, uniqueStrings, withTaskEnvelope } from './shared';

export type MailAssistantContext = {
  message: {
    id: string;
    fromEmail: string;
    subject: string;
    text: string;
  };
  event?: {
    id: string;
    name: string;
    contactEmail?: string | null;
  } | null;
  entry?: {
    id: string;
    driverName?: string | null;
    className?: string | null;
    vehicleLabel?: string | null;
    registrationStatusLabel?: string | null;
    acceptanceStatusLabel?: string | null;
    paymentStatusLabel?: string | null;
    amountOpenCents?: number;
    paymentReference?: string | null;
    missingDocumentsKnown: boolean;
    missingDocuments: string[];
  } | null;
  approvedKnowledge: KnowledgeItem[];
  previousOutgoingCommunication: string[];
  operatorInput?: {
    additionalContext?: string;
    mustMention?: string[];
    mustAvoid?: string[];
  };
};

const replySchema = z.object({
  summary: z.string().min(1).max(600),
  category: z.enum(['zahlung', 'nennung', 'unterlagen', 'presse', 'eventlogistik', 'rueckfrage', 'sonstiges']),
  replySubject: z.string().min(1).max(240).optional(),
  answerFacts: z.array(z.string().min(1).max(240)).max(8).default([]),
  unknowns: z.array(z.string().min(1).max(280)).max(8).default([]),
  replyDraft: z.string().min(1).max(4000),
  warnings: z.array(z.string()).max(8).default([]),
  confidence: z.enum(['low', 'medium', 'high'])
});

const buildReplySystemPrompt = () =>
  [
    'You are an assistant for the back office of a motorsport event system.',
    'Write the final replyDraft in German.',
    'Use only the provided facts.',
    'Never mention internal status codes or field names.',
    'Never claim that documents are missing unless the context explicitly lists missing documents.',
    'If concrete information is missing, say so explicitly and conservatively.',
    'Return valid JSON with summary, category, replySubject, answerFacts, unknowns, replyDraft, warnings, confidence.'
  ].join(' ');

const buildReplySubject = (subject: string) => (/^re:\s*/i.test(subject) ? subject : `Re: ${subject}`);

const buildHumanFacts = (context: MailAssistantContext) => {
  const confirmedFacts = uniqueStrings([
    context.entry?.registrationStatusLabel,
    context.entry?.acceptanceStatusLabel,
    context.entry?.paymentStatusLabel,
    context.event?.contactEmail ? `Kontaktadresse: ${context.event.contactEmail}` : null,
    context.entry?.paymentReference ? `Verwendungszweck: ${context.entry.paymentReference}` : null
  ]);

  const unknowns = uniqueStrings([
    !context.entry?.missingDocumentsKnown ? 'Welche konkreten Unterlagen oder Angaben noch fehlen, ist im System aktuell nicht strukturiert hinterlegt.' : null,
    ...(context.entry?.missingDocumentsKnown && context.entry.missingDocuments.length === 0
      ? ['Es sind keine fehlenden Unterlagen im System hinterlegt.']
      : [])
  ]);

  return { confirmedFacts, unknowns };
};

export const generateReplySuggestion = async (context: MailAssistantContext) => {
  const humanFacts = buildHumanFacts(context);

  const generated = await generateStructuredObject({
    schema: replySchema,
    systemPrompt: buildReplySystemPrompt(),
    userPrompt: JSON.stringify({
      message: context.message,
      event: context.event ?? null,
      entry: context.entry ?? null,
      confirmedFacts: humanFacts.confirmedFacts,
      unknowns: humanFacts.unknowns,
      approvedKnowledge: context.approvedKnowledge,
      previousOutgoingCommunication: context.previousOutgoingCommunication,
      operatorInput: context.operatorInput ?? null
    }),
    maxTokens: 900,
    temperature: 0.2
  });

  const warningObjects: AiWarning[] = [
    ...normalizeWarnings(generated.data.warnings ?? [], 'REVIEW_NOTE'),
    ...humanFacts.unknowns.map((unknown) => ({
      code: 'UNKNOWN_CONTEXT',
      severity: 'medium' as const,
      message: unknown,
      displayMessage: unknown,
      recommendation: 'Bitte die offene Stelle vor der Uebernahme pruefen.'
    }))
  ];

  const confidence =
    humanFacts.unknowns.length > 0 || warningObjects.length > 0
      ? (generated.data.confidence === 'high' ? 'medium' : generated.data.confidence)
      : generated.data.confidence;

  return withTaskEnvelope({
    task: 'reply_suggestion',
    result: {
      summary: generated.data.summary,
      category: generated.data.category,
      replySubject: generated.data.replySubject?.trim() || buildReplySubject(context.message.subject),
      answerFacts: uniqueStrings([...(generated.data.answerFacts ?? []), ...humanFacts.confirmedFacts]),
      unknowns: uniqueStrings([...(generated.data.unknowns ?? []), ...humanFacts.unknowns]),
      replyDraft: generated.data.replyDraft
    },
    basis: {
      message: {
        id: context.message.id,
        subject: context.message.subject
      },
      event: context.event ?? null,
      entry: context.entry ?? null,
      knowledgeHits: context.approvedKnowledge,
      operatorInput: context.operatorInput ?? null,
      usedKnowledge: {
        approvedKnowledgeCount: context.approvedKnowledge.length,
        previousOutgoingCount: context.previousOutgoingCommunication.length,
        basedOnPreviousCorrespondence: context.previousOutgoingCommunication.length > 0
      }
    },
    warnings: warningObjects,
    confidence,
    modelId: generated.modelId
  });
};
