const path = require('node:path');

const campaign = require(path.resolve(__dirname, 'campaigns/2026-09-abschlussmail.i18n.json'));
const { renderMailContract } = require(path.resolve(__dirname, '../api/dist/mail/rendering.js'));
const { sendEmail } = require(path.resolve(__dirname, '../api/dist/mail/ses.js'));

const RECIPIENT = 'vinni.geisler@gmail.com';
const NEWSLETTER_URL = 'https://www.msc-oberlausitz.de/newsletter';
const SUPPORTED_LOCALES = new Set(['de', 'en', 'cs', 'pl']);

const splitFreeFormContent = (value) => {
  const blocks = value.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length < 4) {
    throw new Error('Campaign body does not contain enough blocks for greeting, content and closing.');
  }
  const greetingText = blocks.shift();
  const closingText = blocks.splice(-2).join('\n\n');
  return { greetingText, contentText: blocks.join('\n\n'), closingText };
};

const main = async () => {
  const args = process.argv.slice(2);
  const mode = args.find((argument) => argument === '--check' || argument === '--send');
  if (mode !== '--check' && mode !== '--send') {
    throw new Error('Explicit --check or --send flag required.');
  }
  const localeFlagIndex = args.indexOf('--locale');
  const locale = localeFlagIndex >= 0 ? args[localeFlagIndex + 1] : 'de';
  if (!SUPPORTED_LOCALES.has(locale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  if (process.env.AWS_PROFILE !== 'verein') {
    throw new Error('AWS_PROFILE must be "verein".');
  }

  const content = campaign.localizedContent[locale];
  const freeFormContent = splitFreeFormContent(content.bodyText);
  const rendered = renderMailContract({
    templateKey: 'free_form',
    subjectTemplate: content.subject,
    bodyTextTemplate: content.bodyText,
    bodyHtmlTemplate: null,
    data: {
      eventName: '12. Oberlausitzer Dreieck 2026',
      locale,
      preheader: content.preheader,
      heroSubtitle: content.heroSubtitle,
      eventDateText: content.eventDateText,
      ...freeFormContent,
      ctaText: content.ctaText,
      ctaUrl: NEWSLETTER_URL
    },
    renderOptions: {
      showBadge: false,
      mailLabel: null,
      includeEntryContext: false
    },
    hasContentOverride: false
  });

  if (rendered.missingPlaceholders.length > 0) {
    throw new Error(`Missing placeholders: ${rendered.missingPlaceholders.join(', ')}`);
  }
  if (rendered.unknownPlaceholders.length > 0) {
    throw new Error(`Unknown placeholders: ${rendered.unknownPlaceholders.join(', ')}`);
  }
  if (!rendered.htmlDocument.includes(`href="${NEWSLETTER_URL}"`)) {
    throw new Error('Rendered newsletter link is not clickable.');
  }
  if (!rendered.htmlDocument.includes('background:#FACC15') || !rendered.htmlDocument.includes(content.ctaText)) {
    throw new Error('Rendered newsletter CTA is not the yellow MailSystem button.');
  }
  const ctaPosition = rendered.htmlDocument.indexOf('class="mail-cta"');
  const closingPosition = rendered.htmlDocument.indexOf(freeFormContent.closingText.split(/\r?\n/)[0]);
  if (ctaPosition < 0 || closingPosition < 0 || ctaPosition > closingPosition) {
    throw new Error('Rendered newsletter CTA is not positioned before the closing text.');
  }

  if (mode === '--check') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      recipient: RECIPIENT,
      locale,
      subject: rendered.subjectRendered,
      newsletterUrl: NEWSLETTER_URL,
      clickableNewsletterLink: true,
      ctaText: content.ctaText,
      yellowMailSystemButton: true,
      buttonBeforeClosing: true,
      attachments: 0
    }, null, 2)}\n`);
    return;
  }

  const result = await sendEmail(
    RECIPIENT,
    rendered.subjectRendered,
    rendered.bodyTextRendered,
    rendered.htmlDocument
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    recipient: RECIPIENT,
    locale,
    subject: rendered.subjectRendered,
    attachments: 0,
    messageId: result.MessageId ?? null
  }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
