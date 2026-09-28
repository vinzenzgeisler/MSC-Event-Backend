const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration 0113 --------------------------------------------------------------------------------
const migration = read('api/migrations/0113_racepic_stepup_passkeys.sql');
for (const table of ['racepic_passkey_credential', 'racepic_webauthn_challenge', 'racepic_step_up_grant']) {
  assert.match(migration, new RegExp(`create table if not exists "${table}"`));
}
assert.doesNotMatch(migration, /on delete cascade/i);
assert.match(migration, /"credential_id" text not null/);
assert.match(migration, /racepic_passkey_credential_id_unique/);
assert.match(migration, /"purpose" in \('REGISTER', 'STEP_UP'\)/);
assert.match(migration, /"action" in \('PAYMENT_ACCOUNT', 'IDENTITY_CHANGE'\)/);

// --- Infrastruktur: Flag, Umgebung, Routen -------------------------------------------------------------
const stack = read('infra/lib/stacks/api-stack.ts');
assert.match(stack, /RACEPIC_PASSKEY_RP_ID: props\.config\.racepicPhotographerRelyingPartyId/);
assert.match(stack, /RACEPIC_PASSKEY_ORIGINS: props\.config\.racepicMediaCorsAllowedOrigins\.join/);
for (const route of [
  '/photographer/passkeys', '/photographer/passkeys/{passkeyId}', '/photographer/passkeys/registration-options',
  '/photographer/passkeys/registration-verify', '/photographer/step-up/challenge', '/photographer/step-up/verify',
  '/photographer/payment-account', '/photographer/payment-account/onboarding-link', '/photographer/payment-account/dashboard-link'
]) {
  assert.ok(stack.includes(`path: '${route}'`), `Route ${route} fehlt im API Gateway`);
}
assert.doesNotMatch(read('api/src/commerce/paymentAccount.ts'), /console\./);

const makeScriptedDb = (handlers) => {
  const log = [];
  const query = async (text, values) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    log.push({ text: normalized, values });
    for (const [needle, respond] of handlers) {
      if (normalized.includes(needle)) return respond(values, normalized);
    }
    return { rows: [], rowCount: 0 };
  };
  return { log, query };
};
const has = (db, needle) => db.log.some((entry) => entry.text.includes(needle));

(async () => {
  // --- Auth-Kontext: Sitzungsreferenz --------------------------------------------------------------
  const { getPhotographerAuthContext, satisfiesStepUp } = require('../dist/racepic/auth.js');
  const eventWith = (claims) => ({ requestContext: { authorizer: { jwt: { claims } } } });
  assert.equal(getPhotographerAuthContext(eventWith({ sub: 's', origin_jti: 'o-1', auth_time: 100 })).sessionRef, 'o-1');
  assert.equal(getPhotographerAuthContext(eventWith({ sub: 's', auth_time: '100' })).sessionRef, 'auth_time:100');
  assert.equal(getPhotographerAuthContext(eventWith({ sub: 's' })).sessionRef, null);
  assert.equal(satisfiesStepUp({ sub: 's', email: null, emailVerified: true, authTime: Date.now() / 1000, sessionRef: 'x' }, 'strong'), false, 'strong laeuft nur ueber Grants');

  // --- Step-up-Dienst (WebAuthn-Bibliothek ersetzt) ---------------------------------------------------
  const stepUp = require('../dist/racepic/stepUp.js');
  const config = { rpID: 'msc.example', rpName: 'MSC RacePic', origins: ['https://msc.example'] };
  assert.throws(() => stepUp.getPasskeyConfig({}), (e) => e.code === 'PASSKEY_CONFIG_MISSING');
  assert.deepEqual(stepUp.getPasskeyConfig({ RACEPIC_PASSKEY_RP_ID: 'a.de', RACEPIC_PASSKEY_ORIGINS: 'https://a.de, http://localhost:8080' }).origins, ['https://a.de', 'http://localhost:8080']);

  const credentialRow = { id: 'cred-row', photographer_id: 'p1', credential_id: 'cred-abc', public_key: Buffer.from([1, 2, 3]).toString('base64url'), counter: '4', transports: ['internal'] };
  const passthroughDeps = (overrides = {}) => ({
    generateRegistrationOptions: async (opts) => ({ challenge: 'reg-challenge', rp: { id: opts.rpID }, excluded: opts.excludeCredentials }),
    verifyRegistrationResponse: async () => ({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred', publicKey: new Uint8Array([9, 8, 7]), counter: 0, transports: ['internal'] }, credentialDeviceType: 'multiDevice', credentialBackedUp: true }
    }),
    generateAuthenticationOptions: async (opts) => ({ challenge: 'auth-challenge', allowCredentials: opts.allowCredentials, userVerification: opts.userVerification }),
    verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 5 } }),
    ...overrides
  });

  // Ohne Passkey kein Step-up; ohne Sitzung keine Challenge.
  await assert.rejects(() => stepUp.beginStepUp(makeScriptedDb([]), 'p1', 'sess', 'PAYMENT_ACCOUNT', config, passthroughDeps()), (e) => e.code === 'PASSKEY_REQUIRED');
  await assert.rejects(() => stepUp.beginStepUp(makeScriptedDb([]), 'p1', null, 'PAYMENT_ACCOUNT', config, passthroughDeps()), (e) => e.code === 'SESSION_UNKNOWN');

  // Challenge wird gespeichert und verlangt User Verification.
  const beginDb = makeScriptedDb([['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })]]);
  const options = await stepUp.beginStepUp(beginDb, 'p1', 'sess', 'PAYMENT_ACCOUNT', config, passthroughDeps());
  assert.equal(options.userVerification, 'required');
  assert.deepEqual(options.allowCredentials.map((c) => c.id), ['cred-abc']);
  const stored = beginDb.log.find((entry) => entry.text.startsWith('insert into racepic_webauthn_challenge'));
  assert.deepEqual(stored.values.slice(0, 5), ['p1', 'STEP_UP', 'PAYMENT_ACCOUNT', 'sess', 'auth-challenge']);

  // Verifizierung: ohne offene Challenge nichts; Challenge wird VOR der Pruefung verbraucht.
  const assertion = { id: 'cred-abc', rawId: 'cred-abc', type: 'public-key', response: {} };
  await assert.rejects(() => stepUp.finishStepUp(makeScriptedDb([]), 'p1', 'sess', 'PAYMENT_ACCOUNT', assertion, config, passthroughDeps()), (e) => e.code === 'CHALLENGE_INVALID');

  const challengeHandler = ['update racepic_webauthn_challenge set consumed_at', () => ({ rows: [{ challenge: 'auth-challenge' }], rowCount: 1 })];
  const unknownDb = makeScriptedDb([challengeHandler, ['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })]]);
  await assert.rejects(
    () => stepUp.finishStepUp(unknownDb, 'p1', 'sess', 'PAYMENT_ACCOUNT', { ...assertion, id: 'fremde-credential' }, config, passthroughDeps()),
    (e) => e.code === 'CREDENTIAL_UNKNOWN'
  );

  const failingDb = makeScriptedDb([challengeHandler, ['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })]]);
  await assert.rejects(
    () => stepUp.finishStepUp(failingDb, 'p1', 'sess', 'PAYMENT_ACCOUNT', assertion, config, passthroughDeps({ verifyAuthenticationResponse: async () => { throw new Error('bad signature'); } })),
    (e) => e.code === 'VERIFICATION_FAILED'
  );
  assert.ok(has(failingDb, 'update racepic_webauthn_challenge set consumed_at'), 'Challenge ist auch bei Fehlschlag verbraucht');
  assert.equal(has(failingDb, 'insert into racepic_step_up_grant'), false, 'kein Grant ohne gueltige Assertion');

  const unverifiedDb = makeScriptedDb([challengeHandler, ['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })]]);
  await assert.rejects(
    () => stepUp.finishStepUp(unverifiedDb, 'p1', 'sess', 'PAYMENT_ACCOUNT', assertion, config, passthroughDeps({ verifyAuthenticationResponse: async () => ({ verified: false, authenticationInfo: { newCounter: 0 } }) })),
    (e) => e.code === 'VERIFICATION_FAILED'
  );
  assert.equal(has(unverifiedDb, 'insert into racepic_step_up_grant'), false);

  let seenVerifyOptions;
  const okDb = makeScriptedDb([
    challengeHandler,
    ['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })],
    ['insert into racepic_step_up_grant', () => ({ rows: [{ expires_at: new Date('2026-09-28T12:05:00Z') }], rowCount: 1 })]
  ]);
  const grant = await stepUp.finishStepUp(okDb, 'p1', 'sess', 'PAYMENT_ACCOUNT', assertion, config, passthroughDeps({
    verifyAuthenticationResponse: async (opts) => { seenVerifyOptions = opts; return { verified: true, authenticationInfo: { newCounter: 5 } }; }
  }));
  assert.equal(grant.expiresAt, '2026-09-28T12:05:00.000Z');
  assert.equal(seenVerifyOptions.expectedChallenge, 'auth-challenge');
  assert.equal(seenVerifyOptions.requireUserVerification, true);
  assert.deepEqual([...seenVerifyOptions.credential.publicKey], [1, 2, 3]);
  assert.equal(seenVerifyOptions.credential.counter, 4);
  assert.deepEqual(okDb.log.find((e) => e.text.startsWith('update racepic_passkey_credential set counter')).values.slice(1), [5]);
  assert.equal(okDb.log.find((e) => e.text.startsWith('insert into racepic_step_up_grant')).values[4], 300, 'Grant gilt 5 Minuten');

  // Grant verbrauchen: einmalig, an Sitzung/Aktion gebunden, Passkey darf nicht widerrufen sein.
  const noQueryDb = makeScriptedDb([]);
  assert.equal(await stepUp.consumeStepUpGrant(noQueryDb, 'p1', 'PAYMENT_ACCOUNT', null), false);
  assert.equal(noQueryDb.log.length, 0);
  const consumeDb = makeScriptedDb([['update racepic_step_up_grant set consumed_at', () => ({ rows: [], rowCount: 1 })]]);
  assert.equal(await stepUp.consumeStepUpGrant(consumeDb, 'p1', 'PAYMENT_ACCOUNT', 'sess'), true);
  const consumeSql = consumeDb.log[0].text;
  for (const part of ['g.session_ref = $3', 'g.action = $2', 'g.photographer_id = $1', 'g.consumed_at is null', 'g.expires_at > now()', 'c.revoked_at is null', 'and consumed_at is null']) {
    assert.ok(consumeSql.includes(part), `Grant-Abfrage prueft nicht: ${part}`);
  }
  assert.equal(await stepUp.consumeStepUpGrant(makeScriptedDb([]), 'p1', 'PAYMENT_ACCOUNT', 'sess'), false);

  // Registrierung.
  const regDb = makeScriptedDb([['from racepic_passkey_credential', () => ({ rows: [credentialRow], rowCount: 1 })]]);
  const regOptions = await stepUp.beginPasskeyRegistration(regDb, { id: 'p1', email: 'a@b.de', displayName: 'A' }, 'sess', config, passthroughDeps());
  assert.deepEqual(regOptions.excluded.map((c) => c.id), ['cred-abc'], 'vorhandene Passkeys werden ausgeschlossen');
  assert.equal(regDb.log.find((e) => e.text.startsWith('insert into racepic_webauthn_challenge')).values[1], 'REGISTER');
  await assert.rejects(() => stepUp.beginPasskeyRegistration(regDb, { id: 'p1', email: 'a@b.de', displayName: 'A' }, null, config, passthroughDeps()), (e) => e.code === 'SESSION_UNKNOWN');

  const regChallenge = ['update racepic_webauthn_challenge set consumed_at', () => ({ rows: [{ challenge: 'reg-challenge' }], rowCount: 1 })];
  const regResponse = { id: 'new-cred', rawId: 'new-cred', type: 'public-key', response: {} };
  const regOk = makeScriptedDb([regChallenge, ['insert into racepic_passkey_credential', () => ({ rows: [{ id: 'new-row' }], rowCount: 1 })]]);
  assert.deepEqual(await stepUp.finishPasskeyRegistration(regOk, 'p1', 'sess', regResponse, 'Laptop', config, passthroughDeps()), { id: 'new-row' });
  const inserted = regOk.log.find((e) => e.text.startsWith('insert into racepic_passkey_credential')).values;
  assert.equal(inserted[2], Buffer.from([9, 8, 7]).toString('base64url'));
  const regDuplicate = makeScriptedDb([regChallenge]);
  await assert.rejects(() => stepUp.finishPasskeyRegistration(regDuplicate, 'p1', 'sess', regResponse, null, config, passthroughDeps()), (e) => e.code === 'VERIFICATION_FAILED');
  await assert.rejects(
    () => stepUp.finishPasskeyRegistration(makeScriptedDb([regChallenge]), 'p1', 'sess', regResponse, null, config, passthroughDeps({ verifyRegistrationResponse: async () => ({ verified: false }) })),
    (e) => e.code === 'VERIFICATION_FAILED'
  );
  await assert.rejects(() => stepUp.finishPasskeyRegistration(makeScriptedDb([]), 'p1', 'sess', regResponse, null, config, passthroughDeps()), (e) => e.code === 'CHALLENGE_INVALID');

  // Widerruf: nur eigene, aktive Passkeys; offene Grants verfallen.
  await assert.rejects(() => stepUp.revokePasskey(makeScriptedDb([]), 'p1', 'x'), (e) => e.code === 'PASSKEY_NOT_FOUND');
  const revokeDb = makeScriptedDb([['update racepic_passkey_credential set revoked_at', () => ({ rows: [], rowCount: 1 })]]);
  await stepUp.revokePasskey(revokeDb, 'p1', 'x');
  assert.ok(has(revokeDb, 'update racepic_step_up_grant set consumed_at = now() where credential_id = $1'));

  // --- Zahlungskonto (Stripe ersetzt) ----------------------------------------------------------------
  const pa = require('../dist/commerce/paymentAccount.js');
  const active = { charges_enabled: false, payouts_enabled: true, details_submitted: true, capabilities: { transfers: 'active' }, requirements: { currently_due: [], past_due: [] } };
  assert.equal(pa.deriveAccountState(active).status, 'ENABLED');
  assert.equal(pa.deriveAccountState({ ...active, capabilities: { transfers: 'pending' } }).status, 'PENDING');
  assert.equal(pa.deriveAccountState({ ...active, payouts_enabled: false }).status, 'PENDING');
  assert.equal(pa.deriveAccountState({ ...active, details_submitted: false }).status, 'PENDING');
  assert.equal(pa.deriveAccountState({ ...active, requirements: { past_due: ['individual.id_number'] } }).status, 'RESTRICTED');
  assert.equal(pa.deriveAccountState({ ...active, requirements: { disabled_reason: 'requirements.past_due' } }).status, 'RESTRICTED');
  assert.equal(pa.deriveAccountState({ ...active, requirements: { disabled_reason: 'rejected.fraud' } }).status, 'DISABLED');
  assert.deepEqual(pa.deriveAccountState({ details_submitted: false }).requirements, { currentlyDue: [], pastDue: [], disabledReason: null, currentDeadline: null });

  const urls = { returnUrl: 'https://msc.example/return', refreshUrl: 'https://msc.example/refresh' };
  const makeStripe = (overrides = {}) => {
    const calls = { create: [], links: [], retrieve: [], login: [] };
    return {
      calls,
      accounts: {
        // Nach der v2-Erstellung wird der Anfangsstatus ueber den v1-kompatiblen Retrieve-Endpunkt geladen
        // (die v2-Erstellungsantwort ist nicht v1-foermig), deshalb liefert dieses Fake hier bereits den vollen v1-Stand.
        retrieve: async (id) => { calls.retrieve.push(id); return active; },
        createLoginLink: async (id) => { calls.login.push(id); return { url: 'https://dashboard.stripe.test/login' }; }
      },
      accountLinks: { create: async (params) => { calls.links.push(params); return { url: 'https://connect.stripe.test/setup', expires_at: 1790000000 }; } },
      v2: { core: { accounts: { create: async (params, options) => { calls.create.push({ params, options }); return { id: 'acct_1' }; } } } },
      ...overrides
    };
  };
  const photographerHandler = (status) => ['from racepic_photographer where id', () => ({ rows: [{ id: 'p1', email: 'foto@example.org', status }], rowCount: 1 })];
  const sellerHandler = (row = { id: 's1', status: 'ACTIVE', payouts_blocked: true }) => ['from commerce_seller where photographer_id', () => ({ rows: [row], rowCount: 1 })];

  await assert.rejects(() => pa.createOnboardingLink(makeScriptedDb([photographerHandler('PAYMENT_DISABLED')]), makeStripe(), 'p1', urls), (e) => e.code === 'PHOTOGRAPHER_NOT_ELIGIBLE');
  await assert.rejects(() => pa.createOnboardingLink(makeScriptedDb([photographerHandler('INVITED')]), makeStripe(), 'p1', urls), (e) => e.code === 'PHOTOGRAPHER_NOT_ELIGIBLE');
  await assert.rejects(() => pa.createOnboardingLink(makeScriptedDb([photographerHandler('ACTIVE_FREE')]), makeStripe(), 'p1', { returnUrl: '', refreshUrl: '' }), (e) => e.code === 'ONBOARDING_URLS_MISSING');
  await assert.rejects(() => pa.createOnboardingLink(makeScriptedDb([photographerHandler('ACTIVE_FREE'), sellerHandler({ id: 's1', status: 'SUSPENDED', payouts_blocked: true })]), makeStripe(), 'p1', urls), (e) => e.code === 'SELLER_SUSPENDED');

  // Erstes Onboarding: Konto wird mit stabilem Idempotency-Key, nur `transfers` und ohne Kartenzahlung angelegt.
  const stripe = makeStripe();
  let accountRow;
  const onboardDb = makeScriptedDb([
    photographerHandler('ACTIVE_FREE'),
    sellerHandler(),
    ['from commerce_payment_account where seller_id', () => ({ rows: accountRow ? [accountRow] : [], rowCount: accountRow ? 1 : 0 })],
    ['insert into commerce_payment_account', () => { accountRow = { id: 'pa1', seller_id: 's1', provider_account_id: 'acct_1', status: 'PENDING' }; return { rows: [], rowCount: 1 }; }]
  ]);
  const link = await pa.createOnboardingLink(onboardDb, stripe, 'p1', urls);
  assert.equal(link.url, 'https://connect.stripe.test/setup');
  assert.equal(stripe.calls.create.length, 1, 'Kontoerstellung laeuft ueber die Accounts v2 API, nicht ueber den veralteten Kontotyp express');
  assert.equal(stripe.calls.create[0].params.dashboard, 'express');
  assert.equal(stripe.calls.create[0].params.identity.country, 'de');
  assert.deepEqual(stripe.calls.create[0].params.configuration, { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } });
  assert.deepEqual(stripe.calls.create[0].params.defaults, { currency: 'eur', responsibilities: { fees_collector: 'application', losses_collector: 'application' } });
  assert.equal(stripe.calls.create[0].options.idempotencyKey, 'racepic-connect-account-p1');
  assert.deepEqual(stripe.calls.retrieve, ['acct_1'], 'Anfangsstatus wird ueber den v1-kompatiblen Retrieve-Endpunkt geladen (v2-Erstellungsantwort ist nicht v1-foermig)');
  assert.deepEqual([stripe.calls.links[0].account, stripe.calls.links[0].type, stripe.calls.links[0].return_url], ['acct_1', 'account_onboarding', urls.returnUrl]);
  const statusUpdate = onboardDb.log.find((e) => e.text.startsWith('update racepic_photographer set status'));
  // Der Anfangsstatus kommt jetzt vom (im Fake bereits vollstaendigen) Retrieve-Aufruf, nicht mehr aus der v2-Erstellungsantwort.
  assert.equal(statusUpdate.values[1], 'PAYMENT_ENABLED');
  assert.ok(!statusUpdate.values[2].includes('DISABLED') && !statusUpdate.values[2].includes('PENDING_APPROVAL'), 'gesperrte/neue Profile werden nie umgestellt');
  assert.equal(JSON.stringify(onboardDb.log).includes('account_onboarding'), false, 'Link-Daten werden nicht in die Datenbank geschrieben');

  // Weiteres Onboarding: vorhandenes Konto wird wiederverwendet.
  const stripeAgain = makeStripe();
  const againDb = makeScriptedDb([
    photographerHandler('PAYMENT_ONBOARDING_PENDING'), sellerHandler(),
    ['from commerce_payment_account where seller_id', () => ({ rows: [{ id: 'pa1', seller_id: 's1', provider_account_id: 'acct_1', status: 'PENDING' }], rowCount: 1 })]
  ]);
  await pa.createOnboardingLink(againDb, stripeAgain, 'p1', urls);
  assert.equal(stripeAgain.calls.create.length, 0);
  assert.equal(stripeAgain.calls.links[0].account, 'acct_1');

  // Stripe-Ausfall: neutraler Fehler ohne Details.
  await assert.rejects(
    () => pa.createOnboardingLink(makeScriptedDb([photographerHandler('ACTIVE_FREE'), sellerHandler()]), makeStripe({ v2: { core: { accounts: { create: async () => { throw new Error('sk_live_geheim'); } } } } }), 'p1', urls),
    (e) => e.code === 'STRIPE_UNAVAILABLE' && !String(e.message).includes('sk_live')
  );

  // Dashboard-Link.
  await assert.rejects(() => pa.createDashboardLink(makeScriptedDb([photographerHandler('PAYMENT_ENABLED')]), makeStripe(), 'p1'), (e) => e.code === 'NO_ACCOUNT');
  const incompleteDb = makeScriptedDb([photographerHandler('PAYMENT_ONBOARDING_PENDING'), sellerHandler(),
    ['from commerce_payment_account where seller_id', () => ({ rows: [{ provider_account_id: 'acct_1', details_submitted: false }], rowCount: 1 })]]);
  await assert.rejects(() => pa.createDashboardLink(incompleteDb, makeStripe(), 'p1'), (e) => e.code === 'ONBOARDING_INCOMPLETE');
  const dashStripe = makeStripe();
  const dashDb = makeScriptedDb([photographerHandler('PAYMENT_ENABLED'), sellerHandler(),
    ['from commerce_payment_account where seller_id', () => ({ rows: [{ provider_account_id: 'acct_1', details_submitted: true }], rowCount: 1 })]]);
  assert.equal((await pa.createDashboardLink(dashDb, dashStripe, 'p1')).url, 'https://dashboard.stripe.test/login');
  assert.deepEqual(dashStripe.calls.login, ['acct_1']);

  // Abgleich: Status und Fotografenstatus werden nachgezogen; Steuerfreigabe bleibt davon unberuehrt.
  const syncStripe = makeStripe();
  const accountForSync = { id: 'pa1', seller_id: 's1', provider_account_id: 'acct_1', status: 'PENDING', charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: null, synced_at: null };
  const syncDb = makeScriptedDb([sellerHandler(), ['from commerce_payment_account where seller_id', () => ({ rows: [accountForSync], rowCount: 1 })]]);
  const view = await pa.refreshPaymentAccount(syncDb, syncStripe, 'p1');
  assert.deepEqual(syncStripe.calls.retrieve, ['acct_1']);
  assert.equal(syncDb.log.find((e) => e.text.startsWith('update racepic_photographer set status')).values[1], 'PAYMENT_ENABLED');
  assert.equal(has(syncDb, 'payouts_blocked ='), false, 'die Synchronisation aendert payouts_blocked nie');
  assert.equal(view.payoutsReleased, false, 'ohne geklaerten Steuerstatus keine Auszahlungsfreigabe');
  assert.equal((await pa.refreshPaymentAccount(makeScriptedDb([]), syncStripe, 'p1')).hasAccount, false);

  // --- HTTP-Schicht ------------------------------------------------------------------------------------
  const dbClient = require('../dist/db/client.js');
  const { handlePasskeyRoutes } = require('../dist/racepic/stepUpRoutes.js');
  const { handlePaymentAccountRoutes } = require('../dist/commerce/paymentAccountRoutes.js');
  const makeEvent = (method, routePath, claims = { sub: 'u1', auth_time: Math.floor(Date.now() / 1000), origin_jti: 'sess' }, extra = {}) => ({
    requestContext: { http: { method, path: routePath }, authorizer: { jwt: { claims } } },
    headers: {},
    body: extra.body ?? null,
    queryStringParameters: extra.query ?? {}
  });
  const deps = (webAuthn) => ({ requireActivePhotographer: async () => ({ ok: true, photographer: { id: 'p1', email: 'a@b.de', displayName: 'A' } }), webAuthn });
  const previousFlag = process.env.COMMERCE_SETTLEMENT;
  const previousEnv = { rp: process.env.RACEPIC_PASSKEY_RP_ID, origins: process.env.RACEPIC_PASSKEY_ORIGINS, site: process.env.RACEPIC_WEBSITE_BASE_URL };
  try {
    delete process.env.COMMERCE_SETTLEMENT;
    assert.equal(await handlePasskeyRoutes(makeEvent('GET', '/photographer/images'), deps()), null);
    assert.equal((await handlePasskeyRoutes(makeEvent('GET', '/photographer/passkeys'), deps())).statusCode, 404);
    assert.equal((await handlePaymentAccountRoutes(makeEvent('GET', '/photographer/payment-account'), deps())).statusCode, 404);

    process.env.COMMERCE_SETTLEMENT = 'true';
    process.env.RACEPIC_PASSKEY_RP_ID = 'msc.example';
    process.env.RACEPIC_PASSKEY_ORIGINS = 'https://msc.example';
    process.env.RACEPIC_WEBSITE_BASE_URL = 'https://msc.example/';

    // Passkey verwalten verlangt einen frischen Login (`recent`).
    const oldLogin = { sub: 'u1', auth_time: Math.floor(Date.now() / 1000) - 3600, origin_jti: 'sess' };
    let response = await handlePasskeyRoutes(makeEvent('POST', '/photographer/passkeys/registration-options', oldLogin), deps(passthroughDeps()));
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /STEP_UP_REQUIRED/);
    response = await handlePasskeyRoutes(makeEvent('DELETE', '/photographer/passkeys/11111111-1111-4111-8111-111111111111', oldLogin), deps());
    assert.equal(response.statusCode, 403);

    // Step-up ohne Passkey: 409; ungueltige Aktion: 400.
    dbClient.getPool = async () => makeScriptedDb([]);
    response = await handlePasskeyRoutes(makeEvent('POST', '/photographer/step-up/challenge', undefined, { body: JSON.stringify({ action: 'PAYMENT_ACCOUNT' }) }), deps(passthroughDeps()));
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /PASSKEY_REQUIRED/);
    response = await handlePasskeyRoutes(makeEvent('POST', '/photographer/step-up/challenge', undefined, { body: JSON.stringify({ action: 'DELETE_EVERYTHING' }) }), deps(passthroughDeps()));
    assert.equal(response.statusCode, 400);

    // Zahlungskonto: ohne Step-up-Grant kein Stripe-Aufruf.
    const routeStripe = makeStripe();
    const stripeDeps = { requireActivePhotographer: deps().requireActivePhotographer, stripe: async () => routeStripe };
    dbClient.getPool = async () => makeScriptedDb([]);
    response = await handlePaymentAccountRoutes(makeEvent('POST', '/photographer/payment-account/onboarding-link'), stripeDeps);
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /STEP_UP_REQUIRED/);
    assert.equal(routeStripe.calls.create.length + routeStripe.calls.links.length, 0);
    response = await handlePaymentAccountRoutes(makeEvent('POST', '/photographer/payment-account/dashboard-link', { sub: 'u1' }), stripeDeps);
    assert.equal(response.statusCode, 403, 'ohne erkennbare Sitzung kein Grant');

    // Mit Grant: der Grant wird vor dem Stripe-Aufruf verbraucht und der Link zurueckgegeben (Audit-Schreiben braucht eine DB, daher nur bis dahin).
    const order = [];
    const grantedDb = makeScriptedDb([
      ['update racepic_step_up_grant set consumed_at', () => { order.push('grant'); return { rows: [], rowCount: 1 }; }],
      photographerHandler('ACTIVE_FREE'),
      sellerHandler(),
      ['from commerce_payment_account where seller_id', () => ({ rows: [{ provider_account_id: 'acct_1', details_submitted: true }], rowCount: 1 })]
    ]);
    dbClient.getPool = async () => grantedDb;
    dbClient.getDb = async () => { throw new Error('Audit-DB nicht verfuegbar (Test)'); };
    const trackedStripe = makeStripe();
    trackedStripe.accounts.createLoginLink = async () => { order.push('stripe'); return { url: 'https://dashboard.stripe.test/login' }; };
    await assert.rejects(
      () => handlePaymentAccountRoutes(makeEvent('POST', '/photographer/payment-account/dashboard-link'), { requireActivePhotographer: deps().requireActivePhotographer, stripe: async () => trackedStripe }),
      /Audit-DB nicht verfuegbar/
    );
    assert.deepEqual(order, ['grant', 'stripe']);

    // Status-Abfrage braucht keinen Step-up.
    dbClient.getPool = async () => makeScriptedDb([]);
    response = await handlePaymentAccountRoutes(makeEvent('GET', '/photographer/payment-account'), stripeDeps);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).paymentAccount.hasAccount, false);
  } finally {
    for (const [name, value] of [['COMMERCE_SETTLEMENT', previousFlag], ['RACEPIC_PASSKEY_RP_ID', previousEnv.rp], ['RACEPIC_PASSKEY_ORIGINS', previousEnv.origins], ['RACEPIC_WEBSITE_BASE_URL', previousEnv.site]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log('commerce-connect-stepup.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
