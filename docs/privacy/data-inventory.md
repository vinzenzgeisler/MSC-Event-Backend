# Dateninventar und Datenfluss

## Zweck und Geltungsbereich
Dieses Dokument erfasst alle im Backend persistent gespeicherten Datenfelder (PostgreSQL und Objekt-Speicher-Referenzen), inklusive Audit-/Betriebsdaten.  
Stand: 2026-02-26.

## ANNAHMEN
- ANNAHME: API Gateway Access Logs sind nicht explizit konfiguriert; es werden primar Lambda-Logs in CloudWatch genutzt.
- ANNAHME: Es gibt aktuell keine separate Consent-Tabelle; Consent wird auf `entry` gespeichert.
- ANNAHME: Frontend ist noch getrennt; clientseitige Tracking-Cookies sind standardmaessig deaktiviert.
- ANNAHME: Kein Mandantenmodell mit separater Organisationstabelle; Trennung erfolgt auf Event-Ebene.

## Dateninventar (vollstaendige Feldliste)

| Entity / Speicherobjekt | Datenfelder | Kategorie | Art. 9 DSGVO |
|---|---|---|---|
| `event` | `id`, `name`, `startsAt`, `endsAt`, `status`, `isCurrent`, `registrationOpenAt`, `registrationCloseAt`, `contactEmail`, `websiteUrl`, `openedAt`, `closedAt`, `archivedAt`, `createdAt`, `updatedAt` | Event-/Organisationsdaten, Kontakt | Nein |
| `class` | `id`, `eventId`, `name`, `vehicleType`, `createdAt`, `updatedAt` | Klassifikation | Nein |
| `person` | `id`, `email`, `firstName`, `lastName`, `birthdate`, `nationality`, `street`, `zip`, `city`, `phone`, `emergencyContactName`, `emergencyContactFirstName`, `emergencyContactLastName`, `emergencyContactPhone`, `motorsportHistory`, `createdAt`, `updatedAt` | Stammdaten, Kontakt, Notfallkontakt, Historie | Nein (potenziell sensibel, aber nicht Art. 9 per se) |
| `vehicle` | `id`, `ownerPersonId`, `vehicleType`, `make`, `model`, `year`, `brand`, `displacementCcm`, `engineType`, `powerPs`, `cylinders`, `gears`, `brakes`, `description`, `ownerName`, `vehicleHistory`, `startNumberRaw`, `imageS3Key`, `createdAt`, `updatedAt` | Fahrzeugdaten, techn. Merkmale, Bildreferenz | Nein |
| `entry` | `id`, `eventId`, `classId`, `driverPersonId`, `registrationGroupId`, `codriverPersonId`, `vehicleId`, `backupVehicleId`, `isBackupVehicle`, `backupOfEntryId`, `startNumberNorm`, `driverEmailNorm`, `registrationStatus`, `acceptanceStatus`, `idVerified`, `idVerifiedAt`, `idVerifiedBy`, `checkinIdVerified`, `checkinIdVerifiedAt`, `checkinIdVerifiedBy`, `techStatus`, `techCheckedAt`, `techCheckedBy`, `specialNotes`, `internalNote`, `driverNote`, `deletedAt`, `deletedBy`, `deletedByDisplay`, `deleteReason`, `confirmationMailSentAt`, `confirmationMailVerifiedAt`, `consentTermsAccepted`, `consentPrivacyAccepted`, `consentMediaAccepted`, `consentVersion`, `consentCapturedAt`, `entryFeeCents`, `createdAt`, `updatedAt` | Verfahrensdaten, Einwilligungen, interne Bearbeitung, Soft-Delete-Metadaten | Nein |
| `registration_group` | `id`, `eventId`, `driverPersonId`, `driverEmailNorm`, `deletedAt`, `createdAt`, `updatedAt` | Gruppierungs-/Zuordnungsdaten | Nein |
| `registration_group_email_verification` | `id`, `registrationGroupId`, `token`, `expiresAt`, `verifiedAt`, `createdAt` | Verifikations-/Sicherheitsdaten | Nein |
| `entry_email_verification` | `id`, `entryId`, `token`, `expiresAt`, `verifiedAt`, `createdAt` | Verifikations-/Sicherheitsdaten | Nein |
| `public_entry_submission` | `id`, `eventId`, `clientSubmissionKey`, `payloadHash`, `responsePayload`, `createdAt`, `updatedAt` | Idempotenz-/Replay-Schutz, Response-Snapshot | Nein |
| `invoice` | `id`, `eventId`, `driverPersonId`, `totalCents`, `pricingSnapshot`, `paymentStatus`, `paidAt`, `paidAmountCents`, `recordedBy`, `createdAt`, `updatedAt` | Abrechnung | Nein |
| `invoice_payment` | `id`, `invoiceId`, `amountCents`, `paidAt`, `method`, `recordedBy`, `note`, `createdAt` | Zahlungsbuchungen | Nein |
| `event_pricing_rule` | `id`, `eventId`, `earlyDeadline`, `lateFeeCents`, `secondVehicleDiscountCents`, `currency`, `createdAt`, `updatedAt` | Preisregeln | Nein |
| `class_pricing_rule` | `id`, `eventId`, `classId`, `baseFeeCents`, `createdAt`, `updatedAt` | Preisregeln | Nein |
| `audit_log` | `id`, `eventId`, `actorUserId`, `action`, `entityType`, `entityId`, `payload`, `createdAt` | Revisionsnachweis | Nein |
| `email_outbox` | `id`, `eventId`, `toEmail`, `subject`, `templateId`, `templateVersion`, `templateData`, `status`, `attemptCount`, `maxAttempts`, `errorLast`, `sendAfter`, `idempotencyKey`, `createdAt`, `updatedAt` | Kommunikationssteuerung | Nein |
| `email_delivery` | `id`, `outboxId`, `sesMessageId`, `status`, `sentAt`, `providerResponse` | Zustellnachweise, Providerantwort | Nein |
| `email_template` | `id`, `templateKey`, `description`, `isActive`, `createdAt`, `updatedAt` | Vorlagen-Metadaten | Nein |
| `email_template_version` | `id`, `templateId`, `version`, `subjectTemplate`, `bodyTemplate`, `createdBy`, `createdAt` | Vorlageninhalt, Versionierung | Nein |
| `document` | `id`, `eventId`, `entryId`, `driverPersonId`, `type`, `templateVariant`, `templateVersion`, `sha256`, `s3Key`, `status`, `createdAt`, `createdBy` | Dokument-Metadaten, Integritaetsnachweis | Nein |
| `document_generation_job` | `id`, `documentId`, `status`, `attemptCount`, `lastError`, `createdAt`, `updatedAt` | Jobsteuerung | Nein |
| `export_job` | `id`, `eventId`, `type`, `filters`, `status`, `s3Key`, `errorLast`, `createdBy`, `createdAt`, `completedAt` | Exportsteuerung | Nein |
| `vehicle_image_upload` | `id`, `eventId`, `s3Key`, `contentType`, `fileName`, `fileSizeBytes`, `status`, `expiresAt`, `finalizedAt`, `createdAt`, `updatedAt` | Upload-Metadaten | Nein |
| S3-Objekte (`assets` Bucket) | Objektinhalt (Fahrzeugbilder), Objekt-Key (aus DB referenziert), Objekt-Metadaten (S3-intern) | Medieninhalte | Nein |
| S3-Objekte (`documents` Bucket) | PDF-Dokumentinhalt, Objekt-Key (aus DB referenziert), Objekt-Metadaten (S3-intern) | Vertrags-/Pruefdokumente | Nein |
| CloudWatch Logs (Lambda) | Zeitstempel, Log-Level/Text, Request-/Fehlerkontext (anwendungsabhaengig), AWS Request ID | Betriebs-/Sicherheitslogs | Nein |
| JWT Claims im Request (nicht DB-persistent) | `sub`, `email`, `cognito:groups`, MFA-Info (`amr`) werden zur Laufzeit verarbeitet; Teile davon (z. B. `actorUserId`) in `audit_log` persistiert | Authentisierung/Autorisierung | Nein |

## IP-Adresse und User-Agent
- In der aktuellen Backend-Persistenz gibt es keine dedizierten Felder fuer IP-Adresse oder User-Agent.
- Wenn Infrastruktur-Access-Logs aktiviert werden, koennen IP/User-Agent dort auftauchen.  
  ANNAHME: Das ist derzeit nicht explizit aktiviert und daher kein geplanter Primarspeicher.

## Besondere Kategorien nach Art. 9 DSGVO
- Kein Feld ist zwingend als besondere Kategorie (Art. 9 DSGVO) modelliert.
- Risiko-Hinweis: Freitextfelder (`motorsportHistory`, `specialNotes`, `internalNote`, `driverNote`, `email_outbox.templateData`, `audit_log.payload`) koennen durch Eingaben indirekt sensible Inhalte enthalten.

## Datenfluss (textuell)
1. Erhebung
1. Oeffentliches Formular erhebt Fahrer-/Beifahrer-/Fahrzeug-/Consent-Daten sowie Upload-Metadaten.
1. Admin-Oberflaeche erhebt Bearbeitungsdaten (Status, Notizen, Zahlungen, Dokumentaktionen, Mailversand).
1. Verarbeitung
1. Validierung mit Zod, Normalisierung von E-Mail/Telefon/Startnummer.
1. Business-Regeln (Event offen, Klassenzuordnung, Dubletten-/Idempotenzpruefung, Verifikations-Token).
1. Speicherung
1. Persistenz in PostgreSQL (`person`, `entry`, `vehicle`, `invoice`, `audit_log`, `email_*`, `*_verification`, Jobs).
1. Dateien in S3 (`assets`, `documents`), referenziert ueber `s3Key`.
1. Weitergabe
1. E-Mail-Versand ueber AWS SES mit Empfaengeradresse, Betreff, Template-Inhalt.
1. Presigned URLs fuer Download/Upload (S3), zeitlich begrenzt.
1. IAM-/Auth-Interaktion ueber AWS Cognito.
1. Loeschung
1. Fachlich zuerst Soft Delete fuer `entry` (und `registration_group` wenn leer).
1. Objekt- und Log-Loeschung derzeit nicht vollstaendig automatisiert; Fristen/Mechanismen sind im Loeschkonzept festgelegt.

## Risiken
- P0: Fehlende feste Aufbewahrungs-/Purge-Jobs fuer veraltete Verifikations-Token, Outbox/Delivery-Daten, Exporte und Auditdaten.
- P1: Freitextfelder koennen unbeabsichtigt sensible Daten enthalten (Art. 9-Risiko durch Inhalt, nicht durch Schema).
- P1: Consent-Nachweis ist ohne Text-Hash/Locale/IP technisch nur teilweise beweissicher.
- P2: Unklare Infrastruktur-Logkonfiguration (API Gateway Access Logs) erschwert exakte Datenbilanz fuer IP/User-Agent.
