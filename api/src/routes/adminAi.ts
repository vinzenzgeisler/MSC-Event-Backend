import { z } from 'zod';
import { listInboxMessages } from '../ai/inbox';
import { generateEventReport, generateReplySuggestion, generateSpeakerText, saveGeneratedDraft } from '../ai/service';

const listMessagesSchema = z.object({
  eventId: z.string().uuid().optional(),
  status: z.enum(['imported', 'processed', 'archived']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(25)
});

const suggestReplySchema = z.object({
  tone: z.enum(['friendly', 'neutral', 'formal']).optional().default('friendly'),
  includeWarnings: z.boolean().optional().default(true)
});

const eventReportSchema = z.object({
  eventId: z.string().uuid(),
  format: z.enum(['website', 'social', 'summary']),
  tone: z.enum(['neutral', 'friendly', 'formal']).optional().default('neutral'),
  length: z.enum(['short', 'medium', 'long']).optional().default('medium'),
  highlights: z.array(z.string().min(1).max(280)).max(10).optional().default([])
});

const speakerSchema = z
  .object({
    eventId: z.string().uuid(),
    entryId: z.string().uuid().optional(),
    classId: z.string().uuid().optional(),
    mode: z.enum(['short_intro', 'driver_intro', 'class_overview']),
    highlights: z.array(z.string().min(1).max(280)).max(10).optional().default([])
  })
  .refine((value) => Boolean(value.entryId || value.classId), {
    message: 'Provide entryId or classId'
  });

const saveDraftSchema = z.object({
  taskType: z.enum(['reply_suggestion', 'event_report', 'speaker_text']),
  title: z.string().max(180).optional(),
  status: z.enum(['draft', 'reviewed', 'archived']).optional(),
  eventId: z.string().uuid().optional(),
  entryId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  promptVersion: z.string().max(32).optional(),
  modelId: z.string().max(200).optional(),
  inputSnapshot: z.record(z.unknown()).optional(),
  outputPayload: z.record(z.unknown()),
  warnings: z.array(z.string().max(280)).max(10).optional()
});

export const listAiMessages = async (query: z.infer<typeof listMessagesSchema>) => listInboxMessages(query);

export const suggestReplyForMessage = async (
  messageId: string,
  input: z.infer<typeof suggestReplySchema>,
  actorUserId: string | null
) => generateReplySuggestion(messageId, input, actorUserId);

export const generateAiEventReport = async (input: z.infer<typeof eventReportSchema>, actorUserId: string | null) =>
  generateEventReport(input, actorUserId);

export const generateAiSpeakerText = async (input: z.infer<typeof speakerSchema>, actorUserId: string | null) =>
  generateSpeakerText(input, actorUserId);

export const saveAiDraft = async (input: z.infer<typeof saveDraftSchema>, actorUserId: string | null) =>
  saveGeneratedDraft(input, actorUserId);

export const validateListAiMessagesInput = (query: Record<string, string | undefined>) =>
  listMessagesSchema.parse({
    eventId: query.eventId,
    status: query.status,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });

export const validateSuggestReplyInput = (payload: unknown) => suggestReplySchema.parse(payload);
export const validateGenerateEventReportInput = (payload: unknown) => eventReportSchema.parse(payload);
export const validateGenerateSpeakerTextInput = (payload: unknown) => speakerSchema.parse(payload);
export const validateSaveAiDraftInput = (payload: unknown) => saveDraftSchema.parse(payload);
