import { z } from 'zod';
import { getInboxMessageDetail, listInboxMessages } from '../ai/inbox';
import {
  createKnowledgeItem,
  generateEventReport,
  generateKnowledgeSuggestionsForMessage,
  generateMessageChat,
  getGeneratedDraft,
  generateReplySuggestion,
  generateSpeakerText,
  listGeneratedDrafts,
  listKnowledgeItems,
  listKnowledgeSuggestions,
  updateReplyDraft,
  saveGeneratedDraft
} from '../ai/service';

const knowledgeTopicSchema = z.enum(['documents', 'payment', 'interview', 'logistics', 'contact', 'general']);
const knowledgeStatusSchema = z.enum(['suggested', 'approved', 'rejected', 'archived']);

const listMessagesSchema = z.object({
  eventId: z.string().uuid().optional(),
  status: z.enum(['imported', 'processed', 'archived']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(25)
});

const listDraftsSchema = z.object({
  taskType: z.enum(['reply_suggestion', 'event_report', 'speaker_text']).optional(),
  eventId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20)
});

const suggestReplySchema = z.object({
  tone: z.enum(['friendly', 'neutral', 'formal']).optional().default('friendly'),
  includeWarnings: z.boolean().optional().default(true),
  additionalContext: z.string().min(1).max(2000).optional(),
  mustMention: z.array(z.string().min(1).max(240)).max(8).optional().default([]),
  mustAvoid: z.array(z.string().min(1).max(240)).max(8).optional().default([])
});

const chatHistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  message: z.string().min(1).max(2000)
});

const messageChatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(chatHistoryMessageSchema).max(12).optional().default([]),
  contextMode: z.enum(['reply', 'knowledge_capture']).optional().default('reply')
});

const createKnowledgeSuggestionsSchema = z.object({
  additionalContext: z.string().min(1).max(2000).optional(),
  history: z.array(chatHistoryMessageSchema).max(12).optional().default([]),
  topicHint: knowledgeTopicSchema.optional()
});

const listKnowledgeSuggestionsSchema = z.object({
  eventId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  topic: knowledgeTopicSchema.optional(),
  status: knowledgeStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(20)
});

const createKnowledgeItemSchema = z
  .object({
    suggestionId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    topic: knowledgeTopicSchema.optional(),
    title: z.string().min(1).max(180).optional(),
    content: z.string().min(1).max(3000).optional(),
    status: z.enum(['suggested', 'approved', 'archived']).optional().default('approved'),
    metadata: z.record(z.unknown()).optional()
  })
  .refine((value) => Boolean(value.suggestionId || (value.topic && value.title && value.content)), {
    message: 'Provide suggestionId or topic, title and content'
  });

const listKnowledgeItemsSchema = z.object({
  eventId: z.string().uuid().optional(),
  topic: knowledgeTopicSchema.optional(),
  status: z.enum(['suggested', 'approved', 'archived']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20)
});

const eventReportSchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid().optional(),
  scope: z.enum(['event', 'class']).optional().default('event'),
  formats: z.array(z.enum(['website', 'short_summary'])).min(1).max(2),
  tone: z.enum(['neutral', 'friendly', 'formal']).optional().default('neutral'),
  length: z.enum(['short', 'medium', 'long']).optional().default('medium'),
  highlights: z.array(z.string().min(1).max(280)).max(10).optional().default([])
}).refine((value) => value.scope === 'event' || Boolean(value.classId), {
  message: 'Provide classId when scope is class'
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
  warnings: z
    .array(
      z.union([
        z.string().max(280),
        z.object({
          code: z.string().min(1).max(80),
          severity: z.enum(['low', 'medium', 'high']).optional().default('medium'),
          message: z.string().min(1).max(400)
        })
      ])
    )
    .max(10)
    .optional()
});

export const listAiMessages = async (query: z.infer<typeof listMessagesSchema>) => listInboxMessages(query);
export const getAiMessage = async (messageId: string) => getInboxMessageDetail(messageId);
export const listAiDraftHistory = async (query: z.infer<typeof listDraftsSchema>) => listGeneratedDrafts(query);
export const getAiDraft = async (draftId: string) => getGeneratedDraft(draftId);
export const listAiKnowledgeSuggestionHistory = async (query: z.infer<typeof listKnowledgeSuggestionsSchema>) => listKnowledgeSuggestions(query);
export const listAiKnowledgeItemHistory = async (query: z.infer<typeof listKnowledgeItemsSchema>) => listKnowledgeItems(query);

export const suggestReplyForMessage = async (
  messageId: string,
  input: z.infer<typeof suggestReplySchema>,
  actorUserId: string | null
) => generateReplySuggestion(messageId, input, actorUserId);

export const generateChatForMessage = async (
  messageId: string,
  input: z.infer<typeof messageChatSchema>,
  actorUserId: string | null
) => generateMessageChat(messageId, input, actorUserId);

export const generateKnowledgeSuggestionsForAiMessage = async (
  messageId: string,
  input: z.infer<typeof createKnowledgeSuggestionsSchema>,
  actorUserId: string | null
) => generateKnowledgeSuggestionsForMessage(messageId, input, actorUserId);

export const generateAiEventReport = async (input: z.infer<typeof eventReportSchema>, actorUserId: string | null) =>
  generateEventReport(input, actorUserId);

export const generateAiSpeakerText = async (input: z.infer<typeof speakerSchema>, actorUserId: string | null) =>
  generateSpeakerText(input, actorUserId);

export const saveAiDraft = async (input: z.infer<typeof saveDraftSchema>, actorUserId: string | null) =>
  saveGeneratedDraft(input, actorUserId);
const updateReplyDraftSchema = z.object({
  replySubject: z.string().min(1).max(240),
  replyDraft: z.string().min(1).max(4000),
  answerFacts: z.array(z.string().min(1).max(240)).max(12),
  unknowns: z.array(z.string().min(1).max(280)).max(12),
  operatorEdits: z.record(z.unknown()).optional()
});

export const updateAiReplyDraft = async (
  draftId: string,
  input: z.infer<typeof updateReplyDraftSchema>,
  actorUserId: string | null
) => updateReplyDraft(draftId, input, actorUserId);

export const createAiKnowledgeItem = async (input: z.infer<typeof createKnowledgeItemSchema>, actorUserId: string | null) =>
  createKnowledgeItem(input, actorUserId);

export const validateListAiMessagesInput = (query: Record<string, string | undefined>) =>
  listMessagesSchema.parse({
    eventId: query.eventId,
    status: query.status,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });
export const validateListAiDraftsInput = (query: Record<string, string | undefined>) =>
  listDraftsSchema.parse({
    taskType: query.taskType,
    eventId: query.eventId,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });
export const validateListAiKnowledgeSuggestionsInput = (query: Record<string, string | undefined>) =>
  listKnowledgeSuggestionsSchema.parse({
    eventId: query.eventId,
    messageId: query.messageId,
    topic: query.topic,
    status: query.status,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });
export const validateListAiKnowledgeItemsInput = (query: Record<string, string | undefined>) =>
  listKnowledgeItemsSchema.parse({
    eventId: query.eventId,
    topic: query.topic,
    status: query.status,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });

export const validateSuggestReplyInput = (payload: unknown) => suggestReplySchema.parse(payload);
export const validateMessageChatInput = (payload: unknown) => messageChatSchema.parse(payload);
export const validateCreateKnowledgeSuggestionsInput = (payload: unknown) => createKnowledgeSuggestionsSchema.parse(payload);
export const validateGenerateEventReportInput = (payload: unknown) => eventReportSchema.parse(payload);
export const validateGenerateSpeakerTextInput = (payload: unknown) => speakerSchema.parse(payload);
export const validateSaveAiDraftInput = (payload: unknown) => saveDraftSchema.parse(payload);
export const validateCreateAiKnowledgeItemInput = (payload: unknown) => createKnowledgeItemSchema.parse(payload);
export const validateUpdateAiReplyDraftInput = (payload: unknown) => updateReplyDraftSchema.parse(payload);
