import type { SNSEvent } from 'aws-lambda';
import { sendEmail } from '../mail/ses';
import { logOperationalEvent } from '../observability/logger';
import { getOrgaNotificationRecipients } from '../observability/recipients';

type CloudWatchAlarmMessage = {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
  Region?: string;
  TriggeringChildren?: string[];
};

type AlertCopy = {
  area: string;
  meaning: string;
  action: string;
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const alertCopy = (alarmName: string, serializedMessage: string): AlertCopy => {
  const source = `${alarmName} ${serializedMessage}`.toLowerCase();
  const specifics: Array<[string, AlertCopy]> = [
    ['signing-mail-queue-failed', {
      area: 'Haftverzicht · Bestätigungsmail',
      meaning: 'Mindestens ein abgeschlossener Haftverzicht hat keinen Mailauftrag für die unterschriebene PDF.',
      action: 'Im Nennungstool den betroffenen Haftverzicht öffnen und „Mail erneut senden“ ausführen.'
    }],
    ['signing-evidence-incomplete', {
      area: 'Haftverzicht · Nachweis',
      meaning: 'Bei einer abgeschlossenen Unterschrift fehlt ein erwarteter Dokument- oder Auditnachweis.',
      action: 'Keine weitere Unterschrift für denselben Fahrer starten. Zuerst den Vorgang im Operations-Dashboard und in der Sitzungsübersicht prüfen.'
    }],
    ['s3-evidence-missing', {
      area: 'Haftverzicht · Dateispeicher',
      meaning: 'Die Datenbank verweist auf einen Haftverzichtsnachweis, der im Dateispeicher nicht gefunden wurde.',
      action: 'Den betroffenen Vorgang sofort in der Sitzungsübersicht prüfen und den technischen Ansprechpartner informieren.'
    }],
    ['inspection-notification-missing', {
      area: 'Technische Abnahme · Orga-Mail',
      meaning: 'Zu einer Abnahmeentscheidung fehlt mindestens eine erwartete Orga-Benachrichtigung.',
      action: 'Die Entscheidung bleibt gespeichert. Empfänger und Mail-Warteschlange im Operations-Dashboard prüfen.'
    }],
    ['registration-notification-missing', {
      area: 'Nennung · Orga-Mail',
      meaning: 'Zu einer neuen Nennung fehlt mindestens eine erwartete Orga-Benachrichtigung.',
      action: 'Die Nennung bleibt gespeichert. Neue Nennungen und Mail-Warteschlange im Nennungstool prüfen.'
    }],
    ['outbox-overdue', {
      area: 'Mailversand · Warteschlange',
      meaning: 'Mindestens eine Mail wartet seit mehr als fünf Minuten auf den Versand.',
      action: 'Mail-Worker und Warteschlange im Operations-Dashboard prüfen.'
    }],
    ['outbox-stuck-sending', {
      area: 'Mailversand · festhängender Auftrag',
      meaning: 'Mindestens ein Mailauftrag steht ungewöhnlich lange auf „wird gesendet“.',
      action: 'Mail-Worker und betroffenen Auftrag im Nennungstool prüfen.'
    }],
    ['outbox-failed', {
      area: 'Mailversand · fehlgeschlagen',
      meaning: 'Mindestens eine Mail konnte auch nach Wiederholungsversuchen nicht versendet werden.',
      action: 'Fehler des Mailauftrags prüfen und die Mail anschließend erneut einreihen.'
    }],
    ['critical-availability', {
      area: 'Erreichbarkeit',
      meaning: 'API oder Betriebsmonitor waren vorübergehend nicht zuverlässig erreichbar.',
      action: 'Internetverbindung am Terminal prüfen und den Operations-Status öffnen. Laufende Eingaben nicht vorschnell neu starten.'
    }],
    ['critical-mail', {
      area: 'Mailversand',
      meaning: 'Ein Teil der Mailkette – Warteschlange, Worker oder Zustellfeedback – ist gestört.',
      action: 'Mailbereich im Operations-Dashboard prüfen.'
    }],
    ['critical-database', {
      area: 'Datenbank',
      meaning: 'Eine Kapazitäts- oder Verfügbarkeitsgrenze der Datenbank wurde erreicht.',
      action: 'Keine Massenvorgänge starten und den Datenbankbereich im Operations-Dashboard prüfen.'
    }],
    ['critical-workflows', {
      area: 'Veranstaltungsablauf',
      meaning: 'Ein Integritätsprüfer für Haftverzicht, technische Abnahme oder Nennung hat angeschlagen.',
      action: 'Den Bereich „Geschäftskritische Workflows“ im Operations-Dashboard prüfen.'
    }]
  ];
  return specifics.find(([needle]) => source.includes(needle))?.[1] ?? {
    area: 'Systemüberwachung',
    meaning: 'Die automatische Überwachung hat eine Abweichung erkannt.',
    action: 'Den Alarm und die letzten Fehler im Operations-Dashboard prüfen.'
  };
};

const formatTime = (value?: string) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return value ?? 'unbekannt';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'medium',
    timeStyle: 'long'
  }).format(date);
};

export const formatAlarmNotification = (message: CloudWatchAlarmMessage, stage = 'prod') => {
  const alarmName = message.AlarmName ?? 'Unbekannter Alarm';
  const state = message.NewStateValue?.toUpperCase() ?? 'ALARM';
  const isAlarm = state === 'ALARM';
  const copy = alertCopy(alarmName, JSON.stringify(message));
  const statusLabel = isAlarm ? 'STÖRUNG' : state === 'OK' ? 'ENTWARNUNG' : state;
  const statusIcon = isAlarm ? '🔴' : state === 'OK' ? '🟢' : '🟡';
  const time = formatTime(message.StateChangeTime);
  const region = process.env.AWS_REGION ?? 'eu-central-1';
  const consoleUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
  const action = isAlarm ? copy.action : 'Der Prüfer meldet wieder Normalzustand. Es ist keine unmittelbare Aktion erforderlich.';
  const subject = `${statusIcon} MSC Event ${stage.toUpperCase()}: ${statusLabel} · ${copy.area}`;
  const technicalReason = message.NewStateReason?.trim() || message.AlarmDescription?.trim() || 'Keine technische Begründung übermittelt.';
  const text = [
    `${statusIcon} ${statusLabel}: ${copy.area}`,
    '',
    `Zeit: ${time}`,
    `Umgebung: ${stage.toUpperCase()}`,
    '',
    'Was bedeutet das?',
    copy.meaning,
    '',
    'Was ist jetzt zu tun?',
    action,
    '',
    `Alarm öffnen: ${consoleUrl}`,
    '',
    'Technische Details:',
    `Alarm: ${alarmName}`,
    technicalReason
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#172033"><div style="max-width:680px;margin:0 auto;padding:24px"><div style="background:${isAlarm ? '#991b1b' : '#166534'};color:#fff;padding:18px 22px;border-radius:10px 10px 0 0"><div style="font-size:13px;font-weight:700;letter-spacing:.08em">MSC EVENT · ${escapeHtml(stage.toUpperCase())}</div><h1 style="margin:8px 0 0;font-size:24px">${statusIcon} ${escapeHtml(statusLabel)}: ${escapeHtml(copy.area)}</h1></div><div style="background:#fff;padding:22px;border-radius:0 0 10px 10px"><p style="margin-top:0;color:#4b5563">${escapeHtml(time)}</p><h2 style="font-size:17px">Was bedeutet das?</h2><p>${escapeHtml(copy.meaning)}</p><h2 style="font-size:17px">Was ist jetzt zu tun?</h2><p>${escapeHtml(action)}</p><p style="margin:24px 0"><a href="${escapeHtml(consoleUrl)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:11px 16px;border-radius:6px;font-weight:700">Alarm in AWS öffnen</a></p><div style="margin-top:24px;padding:14px;background:#f8fafc;border-radius:6px;color:#475569;font-size:12px"><strong>Technische Details</strong><br>${escapeHtml(alarmName)}<br>${escapeHtml(technicalReason)}</div></div></div></body></html>`;
  return { subject, text, html };
};

export const handler = async (event: SNSEvent) => {
  const recipients = getOrgaNotificationRecipients();
  if (recipients.length === 0) throw new Error('ALERT_RECIPIENTS_MISSING');
  let delivered = 0;
  for (const record of event.Records) {
    const rawMessage = record.Sns.Message;
    let message: CloudWatchAlarmMessage;
    try {
      message = JSON.parse(rawMessage) as CloudWatchAlarmMessage;
    } catch {
      message = { AlarmName: record.Sns.Subject ?? 'AWS-Systemmeldung', NewStateValue: 'ALARM', NewStateReason: rawMessage };
    }
    const formatted = formatAlarmNotification(message, process.env.STAGE ?? 'prod');
    await Promise.all(recipients.map((recipient) => sendEmail(recipient, formatted.subject, formatted.text, formatted.html)));
    delivered += recipients.length;
  }
  logOperationalEvent('info', 'alert.email_delivered', { recipientCount: delivered, processed: event.Records.length });
  return { delivered };
};
