export type KnowledgeTopic = 'documents' | 'payment' | 'interview' | 'logistics' | 'contact' | 'general';

export type KnowledgeItem = {
  id?: string;
  eventId?: string | null;
  topic: KnowledgeTopic;
  title: string;
  content: string;
  status?: 'suggested' | 'approved' | 'archived';
};

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');

export const detectKnowledgeTopics = (value: string): KnowledgeTopic[] => {
  const normalized = normalize(value);
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

export const buildFallbackKnowledgeSuggestions = (input: {
  sourceText: string;
  approvedKnowledge: KnowledgeItem[];
  topicHint?: KnowledgeTopic;
}): KnowledgeItem[] => {
  const paragraphs = input.sourceText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24);

  return paragraphs
    .map((content) => {
      const topic = input.topicHint ?? detectKnowledgeTopics(content)[0] ?? 'general';
      return {
        topic,
        title: content.slice(0, 80),
        content
      } satisfies KnowledgeItem;
    })
    .filter((candidate) => {
      const comparable = candidate.content.toLowerCase();
      return !input.approvedKnowledge.some(
        (existing) => existing.topic === candidate.topic && existing.content.toLowerCase() === comparable
      );
    })
    .slice(0, 5);
};
