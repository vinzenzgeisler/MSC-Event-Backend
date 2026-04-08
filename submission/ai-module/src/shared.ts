export type Confidence = 'low' | 'medium' | 'high';

export type AiWarning = {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  displayMessage?: string;
  recommendation?: string;
};

export type TaskEnvelope<TResult, TBasis> = {
  task: 'reply_suggestion' | 'event_report' | 'speaker_text' | 'message_chat' | 'knowledge_suggestions';
  result: TResult;
  basis: TBasis;
  warnings: AiWarning[];
  review: {
    required: true;
    status: 'draft';
    confidence: Confidence;
    reason: string;
    recommendedChecks: string[];
    blockingIssues: string[];
  };
  meta: {
    modelId: string;
    promptVersion: string;
    generatedAt: string;
  };
};

export const uniqueStrings = (values: Array<string | null | undefined>, limit = 8): string[] =>
  Array.from(
    new Set(
      values
        .map((value) => (value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  ).slice(0, limit);

export const normalizeWarnings = (warnings: string[], fallbackCode: string): AiWarning[] =>
  warnings.map((warning) => ({
    code: fallbackCode,
    severity: 'medium',
    message: warning,
    displayMessage: warning,
    recommendation: 'Bitte den Inhalt vor der Uebernahme kurz manuell pruefen.'
  }));

export const buildReviewReason = (confidence: Confidence, warnings: AiWarning[]) => {
  if (warnings.some((warning) => warning.severity === 'high')) {
    return 'Die Ausgabe enthaelt kritische Unsicherheiten und muss geprueft werden.';
  }
  if (confidence === 'low') {
    return 'Die Ausgabe basiert auf begrenztem Kontext und muss geprueft werden.';
  }
  if (warnings.length > 0) {
    return 'Die Ausgabe enthaelt Hinweise zu fehlendem oder unsicherem Kontext und muss geprueft werden.';
  }
  return 'Die Ausgabe ist ein KI-Entwurf und muss vor der Nutzung fachlich freigegeben werden.';
};

export const buildBlockingIssues = (warnings: AiWarning[]) =>
  warnings.filter((warning) => warning.severity === 'high').map((warning) => warning.message);

export const buildRecommendedChecks = (warnings: AiWarning[], confidence: Confidence): string[] => {
  const checks = new Set<string>();
  if (confidence !== 'high') {
    checks.add('Faktenlage und Tonalitaet kurz manuell pruefen.');
  }
  for (const warning of warnings) {
    if (warning.code === 'UNKNOWN_CONTEXT') {
      checks.add('Offene oder fehlende Fakten vor der Uebernahme pruefen.');
    } else {
      checks.add('Warnhinweise vor der Uebernahme inhaltlich pruefen.');
    }
  }
  return Array.from(checks);
};

export const withTaskEnvelope = <TResult, TBasis>(input: {
  task: TaskEnvelope<TResult, TBasis>['task'];
  result: TResult;
  basis: TBasis;
  warnings: AiWarning[];
  confidence: Confidence;
  modelId: string;
  promptVersion?: string;
}): TaskEnvelope<TResult, TBasis> => ({
  task: input.task,
  result: input.result,
  basis: input.basis,
  warnings: input.warnings,
  review: {
    required: true,
    status: 'draft',
    confidence: input.confidence,
    reason: buildReviewReason(input.confidence, input.warnings),
    recommendedChecks: buildRecommendedChecks(input.warnings, input.confidence),
    blockingIssues: buildBlockingIssues(input.warnings)
  },
  meta: {
    modelId: input.modelId,
    promptVersion: input.promptVersion ?? 'v1',
    generatedAt: new Date().toISOString()
  }
});
