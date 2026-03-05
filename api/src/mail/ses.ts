import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const getSesClient = () => new SESClient({});
const DEFAULT_SES_FROM_EMAIL = 'nennung@msc-oberlausitzer-dreilaendereck.eu';

const getSender = (): string => {
  const sender = process.env.SES_FROM_EMAIL?.trim();
  if (!sender) {
    return DEFAULT_SES_FROM_EMAIL;
  }
  return sender;
};

export const sendEmail = async (to: string, subject: string, bodyText: string, bodyHtml?: string) => {
  const client = getSesClient();
  const command = new SendEmailCommand({
    Source: getSender(),
    Destination: {
      ToAddresses: [to]
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: bodyText },
        ...(bodyHtml && bodyHtml.trim().length > 0 ? { Html: { Data: bodyHtml } } : {})
      }
    }
  });

  return client.send(command);
};
