import { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Fotografen-Identitaet aus dem JWT des eigenstaendigen Photographer-Cognito-Pools (siehe
 * infra/lib/stacks/racepic-stack.ts und docs/memory-bank/racepic-architecture.md Abschnitt E).
 *
 * Bewusst getrennt von api/src/http/auth.ts (Staff-Pool, gruppenbasierte Permissions): Fotografen
 * haben keine Gruppen/Permissions, nur eine an `sub` gebundene RacePic-Identitaet. Die Verknuepfung
 * `sub -> racepic_photographer.id` erfolgt beim Claiming (Paket 2), nicht hier.
 */
export type PhotographerAuthContext = {
  sub: string | null;
  email: string | null;
  emailVerified: boolean;
  /** `auth_time`-Claim in Sekunden seit Epoch, fuer Step-up-Policies (Abschnitt E: "recent"/"strong"). */
  authTime: number | null;
  /**
   * Stabile Kennung der Anmeldesitzung fuer Step-up-Grants: `origin_jti` bleibt ueber Refresh-Token-Rotation
   * gleich, sonst dient `auth_time`. Ein Grant gilt nur in der Sitzung, in der er ausgestellt wurde.
   */
  sessionRef: string | null;
};

export const getPhotographerAuthContext = (event: APIGatewayProxyEventV2): PhotographerAuthContext => {
  const claims = ((event.requestContext as { authorizer?: { jwt?: { claims?: unknown } } }).authorizer?.jwt?.claims ??
    {}) as Record<string, unknown>;

  const sub = typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
  const email = typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null;
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const authTimeRaw = claims.auth_time;
  const authTime =
    typeof authTimeRaw === 'number'
      ? authTimeRaw
      : typeof authTimeRaw === 'string' && authTimeRaw.trim().length > 0
        ? Number(authTimeRaw)
        : null;

  const authTimeValue = authTime !== null && Number.isFinite(authTime) ? authTime : null;
  const originJti = typeof claims.origin_jti === 'string' && claims.origin_jti.length > 0 ? claims.origin_jti : null;

  return {
    sub,
    email,
    emailVerified,
    authTime: authTimeValue,
    sessionRef: originJti ?? (authTimeValue !== null ? `auth_time:${authTimeValue}` : null)
  };
};

/**
 * Step-up-Policy-Stufen (Abschnitt E). Nur `session` und `recent` sind fuer den MVP relevant;
 * `strong` (Passkey-Grant) kommt mit dem Marketplace (Paket M1-M5) und ist hier bereits als Typ
 * vorgesehen, damit spaetere Call-Sites nicht umgebaut werden muessen.
 */
export type StepUpLevel = 'session' | 'recent' | 'strong';

const RECENT_AUTH_WINDOW_SECONDS = 10 * 60;

/**
 * Prueft, ob der aktuelle Login jung genug fuer die verlangte Step-up-Stufe ist.
 * `strong` ist noch nicht implementiert (kein Passkey-Grant-Store, siehe Architekturplan) und
 * liefert bis dahin immer `false`, damit sicherheitskritische Marketplace-Aktionen nicht versehentlich
 * ueber `recent` freigeschaltet werden koennen.
 */
export const satisfiesStepUp = (auth: PhotographerAuthContext, level: StepUpLevel, nowSeconds: number = Date.now() / 1000): boolean => {
  if (!auth.sub) {
    return false;
  }
  if (level === 'session') {
    return true;
  }
  if (level === 'recent') {
    return auth.authTime !== null && nowSeconds - auth.authTime <= RECENT_AUTH_WINDOW_SECONDS;
  }
  return false;
};
