import { z } from 'zod';
import { generateStructuredObject } from './bedrock';
import { KnowledgeItem } from './knowledge';
import { AiWarning, normalizeWarnings, uniqueStrings, withTaskEnvelope } from './shared';

export type ReportFormat = 'website' | 'short_summary';

export type ReportContext = {
  scope: 'event' | 'class';
  event: {
    id: string;
    name: string;
    startsAt?: string | null;
    endsAt?: string | null;
    contactEmail?: string | null;
    websiteUrl?: string | null;
    status?: string | null;
  };
  class?: {
    id: string;
    name: string;
  } | null;
  counts: {
    entriesTotal: number;
    acceptedTotal: number;
    paidTotal: number;
  };
  classes?: Array<{ className: string; count: number }>;
  highlights: string[];
  approvedKnowledge: KnowledgeItem[];
  operatorInput?: {
    additionalContext?: string;
    mustMention?: string[];
    mustAvoid?: string[];
    audience?: string;
    publishChannel?: string;
  };
};

const reportSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  teaser: z.string().max(280).nullable().optional(),
  text: z.string().min(1).max(5000),
  warnings: z.array(z.string()).max(8).default([]),
  uncertainClaims: z.array(z.string().min(1).max(280)).max(8).default([])
});

const buildReportSystemPrompt = () =>
  [
    'You generate factual event communication drafts in German.',
    'Use only the provided data.',
    'Do not invent results, rankings, lap times, sponsors, or quotes.',
    'If information is missing, mention it conservatively in warnings or uncertainClaims.',
    'Return valid JSON with title, teaser, text, warnings, uncertainClaims.'
  ].join(' ');

const buildFactBlocks = (context: ReportContext) => {
  const blocks = [
    {
      key: 'event',
      label: 'Eventstammdaten',
      source: 'event',
      facts: uniqueStrings([
        context.event.name,
        context.event.startsAt ? `Beginn: ${context.event.startsAt}` : null,
        context.event.endsAt ? `Ende: ${context.event.endsAt}` : null,
        context.event.contactEmail ? `Kontakt: ${context.event.contactEmail}` : null
      ])
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

  if (context.class) {
    blocks.push({
      key: 'class',
      label: 'Klassenbezug',
      source: 'event_class',
      facts: [`Klasse: ${context.class.name}`]
    });
  }

  if (context.classes?.length) {
    blocks.push({
      key: 'class_distribution',
      label: 'Klassenverteilung',
      source: 'event_class',
      facts: context.classes.map((item) => `${item.className}: ${item.count}`)
    });
  }

  return blocks.filter((block) => block.facts.length > 0);
};

const buildMissingData = () => [
  'Es liegen keine strukturierten Ergebnisdaten, Platzierungen oder Laufzeiten vor.'
];

export const generateEventReport = async (context: ReportContext, formats: ReportFormat[]) => {
  const factBlocks = buildFactBlocks(context);
  const missingData = buildMissingData();

  const variants = await Promise.all(
    formats.map(async (format) => {
      const generated = await generateStructuredObject({
        schema: reportSchema,
        systemPrompt: buildReportSystemPrompt(),
        userPrompt: JSON.stringify({
          scope: context.scope,
          format,
          event: context.event,
          class: context.class ?? null,
          counts: context.counts,
          classes: context.classes ?? [],
          highlights: context.highlights,
          approvedKnowledge: context.approvedKnowledge,
          operatorInput: context.operatorInput ?? null,
          factBlocks,
          missingData
        }),
        maxTokens: 1000,
        temperature: 0.2
      });

      const warnings: AiWarning[] = [
        ...normalizeWarnings(generated.data.warnings ?? [], 'REVIEW_NOTE'),
        {
          code: 'NO_RESULTS_DATA',
          severity: 'medium',
          message: 'Es liegen keine strukturierten Ergebnisdaten vor; der Bericht basiert auf Stammdaten und manuellen Highlights.',
          displayMessage: 'Der Bericht basiert derzeit auf Stammdaten und manuellen Highlights, nicht auf Ergebnisdaten.',
          recommendation: 'Fuer belastbarere Berichtstexte spaeter strukturierte Ergebnisdaten anbinden.'
        }
      ];

      return {
        format,
        generated,
        warnings
      };
    })
  );

  const variantReview = variants.map((variant) => ({
    format: variant.format,
    confidence: variant.generated.data.uncertainClaims.length > 0 ? 'medium' : 'high',
    blockingIssues: [] as string[],
    uncertainClaims: variant.generated.data.uncertainClaims,
    warnings: variant.warnings
  }));

  const allWarnings = variants.flatMap((variant) => variant.warnings);

  return withTaskEnvelope({
    task: 'event_report',
    result: {
      variants: variants.map((variant) => ({
        format: variant.format,
        title: variant.generated.data.title ?? null,
        teaser: variant.generated.data.teaser ?? null,
        text: variant.generated.data.text,
        highlights: context.highlights
      })),
      variantReview,
      blockingIssues: [],
      uncertainClaims: uniqueStrings(variantReview.flatMap((item) => item.uncertainClaims))
    },
    basis: {
      scope: context.scope,
      event: context.event,
      class: context.class ?? null,
      facts: context.counts,
      highlights: context.highlights,
      factBlocks,
      usedKnowledge: context.approvedKnowledge,
      operatorInput: context.operatorInput ?? null,
      sourceSummary: {
        factBlockCount: factBlocks.length,
        factCount: factBlocks.reduce((sum, block) => sum + block.facts.length, 0),
        approvedKnowledgeCount: context.approvedKnowledge.length,
        manualHighlightsCount: context.highlights.length,
        missingDataCount: missingData.length,
        operatorInputPresent: Boolean(context.operatorInput)
      },
      missingData
    },
    warnings: allWarnings,
    confidence: variantReview.some((item) => item.confidence === 'medium') ? 'medium' : 'high',
    modelId: variants[0]?.generated.modelId ?? 'unknown'
  });
};
