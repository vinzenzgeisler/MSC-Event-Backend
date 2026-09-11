import {
  WAIVER_AUTHORITATIVE_LOCALE,
  WAIVER_VERSION,
  flattenWaiverDocument,
  getWaiverDocument,
  waiverTextHash
} from './waiverContract';
import type { WaiverDocument, WaiverLocale, WaiverSection } from './waiverContract';

export const PAPER_WAIVER_VERSION = `${WAIVER_VERSION}-PAPER` as const;

// Wording pairs to turn the digital-signing contract text into a text suitable for
// printing and signing by hand on paper. Only the passages that explicitly refer to the
// digital signing device/process are touched; the legal substance stays identical.
const PAPER_REPLACEMENTS: Record<WaiverLocale, Array<[string, string]>> = {
  'de-DE': [
    [
      'Der vollständige Inhalt dieser Erklärung wird der unterzeichnenden Person vor Abgabe der digitalen Unterschrift angezeigt.',
      'Der vollständige Inhalt dieser Erklärung ist auf diesem Dokument abgedruckt und wird von der unterzeichnenden Person vor der Unterschrift gelesen.'
    ],
    ['9. Abschließende Bestätigung und digitale Unterzeichnung', '9. Abschließende Bestätigung und Unterschrift'],
    [
      'Die unterzeichnende Person bestätigt, dass ihr die vorstehende Vertrags- und Verzichtserklärung vor Abgabe der digitalen Unterschrift vollständig angezeigt wurde und ausreichend Gelegenheit bestand, deren Inhalt zur Kenntnis zu nehmen.',
      'Die unterzeichnende Person bestätigt, dass ihr die vorstehende Vertrags- und Verzichtserklärung vor der Unterschrift vollständig vorlag und ausreichend Gelegenheit bestand, deren Inhalt zur Kenntnis zu nehmen.'
    ],
    [
      'Mit der digitalen handschriftlichen Unterschrift auf dem vom Veranstalter bereitgestellten Endgerät wird die vorstehende Vertrags- und Verzichtserklärung verbindlich abgegeben.',
      'Mit der eigenhändigen Unterschrift auf diesem ausgedruckten Dokument wird die vorstehende Vertrags- und Verzichtserklärung verbindlich abgegeben.'
    ],
    [
      'Die Unterzeichnung wird zusammen mit der verwendeten Dokumentversion, dem zugrunde liegenden Rechtstext, dem Unterzeichnungszeitpunkt, der Signatur und einem Audit-Nachweis dokumentiert.',
      'Die Unterzeichnung wird zusammen mit der verwendeten Dokumentversion und dem zugrunde liegenden Rechtstext beim Veranstalter aufbewahrt.'
    ]
  ],
  'en-GB': [
    [
      'The full content of this declaration will be shown to the signing person before the digital signature is provided.',
      'The full content of this declaration is printed on this document and is read by the signing person before signing.'
    ],
    ['9. Final confirmation and digital signature', '9. Final confirmation and signature'],
    [
      'The signing person confirms that the complete contractual declaration and waiver above was displayed before the digital signature and that sufficient opportunity was given to read it.',
      'The signing person confirms that the complete contractual declaration and waiver above was available in full before signing and that sufficient opportunity was given to read it.'
    ],
    [
      'The handwritten digital signature on the device supplied by the organiser makes this contractual declaration and waiver binding.',
      'The handwritten signature on this printed document makes this contractual declaration and waiver binding.'
    ],
    [
      'The signature is documented together with the document version used, the underlying legal text, the time of signature, the signature itself and an audit record.',
      'The signed document is kept by the organiser together with the document version used and the underlying legal text.'
    ]
  ],
  'cs-CZ': [
    [
      'Úplný obsah tohoto prohlášení bude podepisující osobě zobrazen před odevzdáním digitálního podpisu.',
      'Úplný obsah tohoto prohlášení je vytištěn na tomto dokumentu a podepisující osoba si jej před podpisem přečte.'
    ],
    ['9. Závěrečné potvrzení a digitální podpis', '9. Závěrečné potvrzení a podpis'],
    [
      'Podepisující osoba potvrzuje, že jí bylo před digitálním podpisem zobrazeno celé výše uvedené prohlášení a měla dostatek příležitostí se s ním seznámit.',
      'Podepisující osoba potvrzuje, že mělo před podpisem k dispozici celé výše uvedené prohlášení a měla dostatek příležitostí se s ním seznámit.'
    ],
    [
      'Digitálním vlastnoručním podpisem na zařízení poskytnutém pořadatelem je toto prohlášení závazně učiněno.',
      'Vlastnoručním podpisem na tomto vytištěném dokumentu je toto prohlášení závazně učiněno.'
    ],
    [
      'Podpis se dokumentuje spolu s verzí dokumentu, podkladovým právním textem, časem podpisu, podpisem a auditním záznamem.',
      'Podepsaný dokument uchovává pořadatel spolu s verzí dokumentu a podkladovým právním textem.'
    ]
  ],
  'pl-PL': [
    [
      'Pełna treść oświadczenia zostanie wyświetlona osobie podpisującej przed złożeniem podpisu cyfrowego.',
      'Pełna treść oświadczenia jest wydrukowana na niniejszym dokumencie i zostaje odczytana przez osobę podpisującą przed podpisaniem.'
    ],
    ['9. Potwierdzenie końcowe i podpis cyfrowy', '9. Potwierdzenie końcowe i podpis'],
    [
      'Osoba podpisująca potwierdza, że przed złożeniem podpisu cyfrowego wyświetlono jej pełną treść powyższego oświadczenia i zapewniono wystarczającą możliwość zapoznania się z nią.',
      'Osoba podpisująca potwierdza, że przed podpisaniem miała dostępną pełną treść powyższego oświadczenia i zapewniono jej wystarczającą możliwość zapoznania się z nią.'
    ],
    [
      'Cyfrowy podpis odręczny na urządzeniu udostępnionym przez organizatora powoduje wiążące złożenie oświadczenia.',
      'Własnoręczny podpis na niniejszym wydrukowanym dokumencie powoduje wiążące złożenie oświadczenia.'
    ],
    [
      'Podpis jest dokumentowany wraz z używaną wersją dokumentu, tekstem prawnym, czasem podpisu, podpisem i zapisem audytowym.',
      'Podpisany dokument jest przechowywany przez organizatora wraz z używaną wersją dokumentu i tekstem prawnym.'
    ]
  ]
};

const applyReplacements = (text: string, replacements: Array<[string, string]>): string =>
  replacements.reduce((current, [search, replace]) => (current === search ? replace : current), text);

const paperSection = (section: WaiverSection, replacements: Array<[string, string]>): WaiverSection => ({
  title: applyReplacements(section.title, replacements),
  paragraphs: section.paragraphs?.map((paragraph) => applyReplacements(paragraph, replacements)),
  bullets: section.bullets?.map((bullet) => applyReplacements(bullet, replacements))
});

export const buildPaperWaiverDocument = (locale: WaiverLocale): WaiverDocument => {
  const source = getWaiverDocument(locale);
  const replacements = PAPER_REPLACEMENTS[locale];
  return {
    id: source.id,
    title: applyReplacements(source.title, replacements),
    summaryLinkLabel: source.summaryLinkLabel,
    intro: source.intro?.map((line) => applyReplacements(line, replacements)),
    sections: source.sections.map((section) => paperSection(section, replacements))
  };
};

export type PaperWaiverContract = {
  documentId: 'haftverzicht';
  locale: WaiverLocale;
  version: typeof PAPER_WAIVER_VERSION;
  title: string;
  fullText: string;
  textHash: string;
  authoritativeLocale: typeof WAIVER_AUTHORITATIVE_LOCALE;
  authoritativeTitle: string;
  authoritativeFullText: string;
  authoritativeTextHash: string;
  authoritativeIntro: string[];
  authoritativeSections: WaiverSection[];
  translation: {
    locale: WaiverLocale;
    title: string;
    fullText: string;
    textHash: string;
    intro: string[];
    sections: WaiverSection[];
    binding: false;
  } | null;
};

export const buildPaperWaiverContract = (locale: WaiverLocale): PaperWaiverContract => {
  const authoritative = buildPaperWaiverDocument(WAIVER_AUTHORITATIVE_LOCALE);
  const translated = locale === WAIVER_AUTHORITATIVE_LOCALE ? null : buildPaperWaiverDocument(locale);
  const fullText = flattenWaiverDocument(authoritative);
  return {
    documentId: 'haftverzicht',
    locale,
    version: PAPER_WAIVER_VERSION,
    title: authoritative.title,
    fullText,
    textHash: waiverTextHash(authoritative),
    authoritativeLocale: WAIVER_AUTHORITATIVE_LOCALE,
    authoritativeTitle: authoritative.title,
    authoritativeFullText: fullText,
    authoritativeTextHash: waiverTextHash(authoritative),
    authoritativeIntro: authoritative.intro ?? [],
    authoritativeSections: authoritative.sections,
    translation: translated
      ? {
          locale,
          title: translated.title,
          fullText: flattenWaiverDocument(translated),
          textHash: waiverTextHash(translated),
          intro: translated.intro ?? [],
          sections: translated.sections,
          binding: false as const
        }
      : null
  };
};
