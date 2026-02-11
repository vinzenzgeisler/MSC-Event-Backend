import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const getSesClient = () => new SESClient({});

const getSender = (): string => {
  const sender = process.env.SES_FROM_EMAIL;
  if (!sender) {
    throw new Error('SES_FROM_EMAIL is not set');
  }
  return sender;
};

export const sendEmail = async (to: string, subject: string, bodyText: string) => {
  const client = getSesClient();
  const command = new SendEmailCommand({
    Source: getSender(),
    Destination: {
      ToAddresses: [to]
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: bodyText }
      }
    }
  });

  return client.send(command);
};
