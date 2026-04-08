import { generateReplySuggestion } from './mailAssistant';

export const handler = async () => {
  const result = await generateReplySuggestion({
    message: {
      id: 'demo-message',
      fromEmail: 'fahrer@example.org',
      subject: 'Rueckfrage zur Nennung',
      text: 'Hallo, ist meine Nennung eingegangen und sind noch Unterlagen offen?'
    },
    event: {
      id: 'demo-event',
      name: 'Motorsportevent Demo'
    },
    entry: {
      id: 'demo-entry',
      registrationStatusLabel: 'Die Nennung ist im System eingegangen und die E-Mail-Adresse ist bestaetigt.',
      acceptanceStatusLabel: 'Die Nennung ist zugelassen.',
      paymentStatusLabel: 'Es ist noch ein offener Betrag von 230,00 EUR vermerkt.',
      missingDocumentsKnown: false,
      missingDocuments: []
    },
    approvedKnowledge: [],
    previousOutgoingCommunication: []
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ...result })
  };
};
