import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Cognito-Zugriff auf den eigenstaendigen Fotografen-Pool (infra/lib/stacks/racepic-stack.ts).
 * Bewusst getrennt von api/src/routes/adminIam.ts (Staff-Pool): andere Pool-ID, andere
 * Attribut-/Gruppenlogik (Fotografen haben keine Cognito-Gruppen, siehe ./auth.ts).
 */
const createClient = () =>
  new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1'
  });

const getPhotographerUserPoolId = (): string => {
  const userPoolId = process.env.RACEPIC_PHOTOGRAPHER_POOL_ID;
  if (!userPoolId) {
    throw new Error('RACEPIC_PHOTOGRAPHER_POOL_NOT_CONFIGURED');
  }
  return userPoolId;
};

/**
 * Legt bei Bedarf einen Cognito-Nutzer fuer die eingeladene E-Mail im Fotografen-Pool an, ohne
 * eine Cognito-eigene Einladungsmail zu verschicken (MessageAction: SUPPRESS) - der Fotograf
 * erhaelt stattdessen die RacePic-Einladungsmail mit dem Claim-Link (siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt E). Kein Passwort wird gesetzt: der Login
 * laeuft ausschliesslich ueber USER_AUTH (Email-OTP/Passkey), siehe infra/racepic-stack.ts.
 *
 * Idempotent: existiert der Nutzer schon (z. B. erneute Einladung fuer ein zweites Event), wird
 * das ignoriert.
 */
export const ensurePhotographerCognitoUser = async (email: string): Promise<void> => {
  const client = createClient();
  const userPoolId = getPhotographerUserPoolId();
  const username = email.trim().toLowerCase();

  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: username },
          // Vertrauenswuerdig, weil nur ueber einen serverseitig geprueften Einladungslink erreichbar
          // (siehe api/src/racepic/repository.ts getConsumableInvitationByToken); ermoeglicht
          // Email-OTP als erste Anmeldung ohne zusaetzlichen Verifizierungsschritt.
          { Name: 'email_verified', Value: 'true' }
        ],
        MessageAction: 'SUPPRESS'
      })
    );
  } catch (error) {
    if (error instanceof UsernameExistsException) {
      return;
    }
    throw error;
  }
};

/** Fuer Diagnose/Support: ob zu einer E-Mail bereits ein Cognito-Nutzer im Fotografen-Pool existiert. */
export const photographerCognitoUserExists = async (email: string): Promise<boolean> => {
  const client = createClient();
  const userPoolId = getPhotographerUserPoolId();
  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email.trim().toLowerCase() }));
    return true;
  } catch {
    return false;
  }
};
