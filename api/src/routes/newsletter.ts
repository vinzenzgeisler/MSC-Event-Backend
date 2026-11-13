import { getPool } from '../db/client';
import {
  CONSENT_VERSION, mailCopy, mailGreeting, normalizeEmail, newToken,
  consentHash, publicBaseUrl, websiteLocale, normalizeNewsletterLocale,
  hashNewsletterToken
} from './newsletterContract';
import type { NewsletterLocale } from './newsletterContract';
export {
  normalizeNewsletterLocale, hashNewsletterToken, getNewsletterConfig,
  validateNewsletterSignup, validateNewsletterEmailRequest,
  validateNewsletterToken, validateNewsletterListQuery
} from './newsletterContract';
import {
  getNewsletterConfig, validateNewsletterSignup, validateNewsletterEmailRequest,
  validateNewsletterToken, validateNewsletterListQuery
} from './newsletterContract';

const queueActionMail = async (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, input: { subscriberId: string; email: string; locale: NewsletterLocale; token: string; action: 'confirm' | 'unsubscribe' }) => {
  const copy = mailCopy[input.locale];
  const lang = websiteLocale(input.locale);
  const isConfirm = input.action === 'confirm';
  const url = `${publicBaseUrl()}/${isConfirm ? 'confirm' : 'unsubscribe'}?lang=${lang}#token=${encodeURIComponent(input.token)}`;
  const version = await client.query("select etv.version from email_template et join email_template_version etv on etv.template_id = et.id where et.template_key = 'free_form' and etv.status = 'published' order by etv.version desc limit 1");
  if (!version.rows[0]) throw new Error('NEWSLETTER_MAIL_TEMPLATE_MISSING');
  await client.query(`insert into email_outbox (to_email, subject, template_id, template_version, template_data, idempotency_key)
    values ($1,$2,'free_form',$3,$4::jsonb,$5) on conflict do nothing`, [
    input.email, isConfirm ? copy.confirmSubject : copy.unsubscribeSubject, version.rows[0].version,
    JSON.stringify({ locale: input.locale, eventName: 'MSC Newsletter', greetingText: mailGreeting[input.locale], contentText: isConfirm ? copy.confirmText : copy.unsubscribeText, ctaUrl: url, ctaText: isConfirm ? copy.confirmCta : copy.unsubscribeCta, nennungstoolUrl: 'https://www.msc-oberlausitz.de', senderProfile: 'newsletter', newsletterSubscriberId: input.subscriberId, renderOptions: { includeEntryContext: false, showBadge: false, mailLabel: 'Newsletter' } }),
    `newsletter:${input.action}:${input.subscriberId}:${hashNewsletterToken(input.token).slice(0, 16)}`
  ]);
};

export const requestNewsletterSignup = async (raw: ReturnType<typeof validateNewsletterSignup>) => {
  if (raw.website || process.env.NEWSLETTER_ENABLED === 'false') return;
  const locale = normalizeNewsletterLocale(raw.locale);
  const email = normalizeEmail(raw.email);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const existingResult = await client.query('select * from newsletter_subscriber where email_norm=$1 for update', [email]);
    const existing = existingResult.rows[0];
    if (existing?.status === 'active') { await client.query('commit'); return; }
    const now = Date.now();
    if (existing?.status === 'pending' && existing.verification_sent_at && now - new Date(existing.verification_sent_at).getTime() < 15 * 60 * 1000) { await client.query('commit'); return; }
    const token = newToken();
    const tokenHash = hashNewsletterToken(token);
    const windowFresh = !existing?.verification_window_started_at || now - new Date(existing.verification_window_started_at).getTime() > 24 * 60 * 60 * 1000;
    const sendCount = windowFresh ? 1 : Number(existing?.verification_send_count || 0) + 1;
    if (sendCount > 3) { await client.query('commit'); return; }
    const subscriberResult = await client.query(`insert into newsletter_subscriber (email,email_norm,locale,status,consent_version,consent_text_hash,verification_token_hash,verification_expires_at,verification_sent_at,verification_window_started_at,verification_send_count,updated_at)
      values ($1,$2,$3,'pending',$4,$5,$6,now()+interval '48 hours',now(),now(),1,now())
      on conflict (email_norm) do update set email=excluded.email,locale=excluded.locale,status='pending',consent_version=excluded.consent_version,consent_text_hash=excluded.consent_text_hash,verification_token_hash=excluded.verification_token_hash,verification_expires_at=excluded.verification_expires_at,verification_sent_at=now(),verification_window_started_at=case when $7 then now() else newsletter_subscriber.verification_window_started_at end,verification_send_count=$8,unsubscribed_at=null,bounced_at=null,complained_at=null,updated_at=now() returning id`, [raw.email.trim(), email, locale, CONSENT_VERSION, consentHash(locale), tokenHash, windowFresh, sendCount]);
    const id = subscriberResult.rows[0].id as string;
    await client.query("insert into newsletter_consent_event (subscriber_id,action,consent_version,consent_text_hash,locale) values ($1,'requested',$2,$3,$4)", [id, CONSENT_VERSION, consentHash(locale), locale]);
    await queueActionMail(client, { subscriberId: id, email, locale, token, action: 'confirm' });
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};

export const confirmNewsletter = async (token: string) => {
  const pool = await getPool(); const client = await pool.connect();
  try { await client.query('begin');
    const result = await client.query('select * from newsletter_subscriber where verification_token_hash=$1 for update', [hashNewsletterToken(token)]);
    const row = result.rows[0];
    if (!row) { await client.query('commit'); return { status: 'invalid' as const }; }
    if (row.status === 'active') { await client.query('commit'); return { status: 'already_confirmed' as const }; }
    if (!row.verification_expires_at || new Date(row.verification_expires_at).getTime() < Date.now()) { await client.query('commit'); return { status: 'expired' as const }; }
    const unsubscribeToken = newToken();
    await client.query("update newsletter_subscriber set status='active',confirmed_at=now(),unsubscribe_token_hash=$2,updated_at=now() where id=$1", [row.id, hashNewsletterToken(unsubscribeToken)]);
    await client.query("insert into newsletter_consent_event (subscriber_id,action,consent_version,consent_text_hash,locale) values ($1,'confirmed',$2,$3,$4)", [row.id, row.consent_version, row.consent_text_hash, row.locale]);
    await client.query('commit'); return { status: 'confirmed' as const };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};

export const requestNewsletterUnsubscribe = async (raw: ReturnType<typeof validateNewsletterEmailRequest>) => {
  if (raw.website) return;
  const email = normalizeEmail(raw.email); const locale = normalizeNewsletterLocale(raw.locale); const pool = await getPool(); const client = await pool.connect();
  try { await client.query('begin'); const result = await client.query("select id,email,locale,status from newsletter_subscriber where email_norm=$1 for update", [email]); const row = result.rows[0];
    if (row?.status === 'active') { const token = newToken(); await client.query('update newsletter_subscriber set unsubscribe_token_hash=$2,updated_at=now() where id=$1', [row.id, hashNewsletterToken(token)]); await queueActionMail(client, { subscriberId: row.id, email: row.email, locale: normalizeNewsletterLocale(row.locale || locale), token, action: 'unsubscribe' }); }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};

export const unsubscribeNewsletter = async (token: string) => {
  const pool = await getPool(); const client = await pool.connect();
  try { await client.query('begin'); const result = await client.query('select * from newsletter_subscriber where unsubscribe_token_hash=$1 for update', [hashNewsletterToken(token)]); const row = result.rows[0];
    if (!row) { await client.query('commit'); return { status: 'invalid' as const }; }
    if (row.status === 'unsubscribed') { await client.query('commit'); return { status: 'already_unsubscribed' as const }; }
    await client.query("update newsletter_subscriber set status='unsubscribed',unsubscribed_at=now(),updated_at=now() where id=$1", [row.id]);
    await client.query("insert into newsletter_consent_event (subscriber_id,action,locale) values ($1,'unsubscribed',$2)", [row.id, row.locale]);
    await client.query('commit'); return { status: 'unsubscribed' as const };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};

export const getNewsletterOverview = async () => { const pool = await getPool(); const result = await pool.query("select count(*)::int total,count(*) filter(where status='active')::int active,count(*) filter(where status='pending')::int pending,count(*) filter(where status='unsubscribed')::int unsubscribed,count(*) filter(where status in ('bounced','complained'))::int suppressed from newsletter_subscriber"); return result.rows[0]; };
export const listNewsletterSubscribers = async (query: ReturnType<typeof validateNewsletterListQuery>) => { const pool = await getPool(); const filters: string[]=[]; const values: unknown[]=[]; if(query.status){values.push(query.status);filters.push(`status=$${values.length}`);} if(query.locale){values.push(query.locale);filters.push(`locale=$${values.length}`);} if(query.search){values.push(`%${query.search.toLowerCase()}%`);filters.push(`email_norm like $${values.length}`);} const where=filters.length?`where ${filters.join(' and ')}`:''; values.push(query.pageSize,(query.page-1)*query.pageSize); const result=await pool.query(`select id,email,locale,status,created_at "createdAt",confirmed_at "confirmedAt",unsubscribed_at "unsubscribedAt",verification_sent_at "verificationSentAt",count(*) over()::int "totalCount" from newsletter_subscriber ${where} order by created_at desc limit $${values.length-1} offset $${values.length}`,values); return { items: result.rows, page: query.page, pageSize: query.pageSize, total: result.rows[0]?.totalCount || 0 }; };
export const adminUnsubscribeNewsletter = async (id: string, actorUserId: string | null) => { const pool=await getPool(); const result=await pool.query("update newsletter_subscriber set status='unsubscribed',unsubscribed_at=now(),updated_at=now() where id=$1 returning id,locale",[id]); if(result.rows[0]) { await pool.query("insert into newsletter_consent_event(subscriber_id,action,locale,source) values($1,'admin_unsubscribed',$2,'admin')",[id,result.rows[0].locale]); await pool.query("insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'newsletter.subscriber_unsubscribed','newsletter_subscriber',$2,'{}'::jsonb)",[actorUserId,id]); } return Boolean(result.rows[0]); };
export const adminResendNewsletterVerification = async (id: string, actorUserId: string | null) => { const pool=await getPool(); const client=await pool.connect(); try{await client.query('begin');const result=await client.query("select * from newsletter_subscriber where id=$1 and status='pending' for update",[id]);const row=result.rows[0];if(!row){await client.query('commit');return false;}const token=newToken();await client.query("update newsletter_subscriber set verification_token_hash=$2,verification_expires_at=now()+interval '48 hours',verification_sent_at=now(),updated_at=now() where id=$1",[id,hashNewsletterToken(token)]);await queueActionMail(client,{subscriberId:id,email:row.email,locale:normalizeNewsletterLocale(row.locale),token,action:'confirm'});await client.query("insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'newsletter.verification_resent','newsletter_subscriber',$2,'{}'::jsonb)",[actorUserId,id]);await client.query('commit');return true;}catch(error){await client.query('rollback');throw error;}finally{client.release();} };

export const runNewsletterRetention = async () => { const pool=await getPool(); const stale=await pool.query("delete from newsletter_subscriber where status='pending' and created_at < now()-interval '14 days'"); const old=await pool.query("delete from newsletter_subscriber where status='unsubscribed' and unsubscribed_at < now()-interval '3 years'"); return { stalePending: stale.rowCount || 0, expiredEvidence: old.rowCount || 0 }; };
