export type LegalUiLocale = "de" | "en" | "cz" | "pl";
export type ConsentLocale = "de-DE" | "en-GB" | "cs-CZ" | "pl-PL";
export type LegalDocId = "impressum" | "datenschutz" | "teilnahmebedingungen" | "haftverzicht";

export const CONSENT_VERSION = "privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0";

export type LegalDocSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDoc = {
  id: LegalDocId;
  title: string;
  summaryLinkLabel: string;
  intro?: string[];
  sections: LegalDocSection[];
};

type SummaryTexts = {
  title: string;
  introTitle: string;
  introBody: string[];
  voluntaryTitle: string;
  voluntaryBody: string;
  waiverNoticeTitle: string;
  waiverNoticeBody: string;
  linksTitle: string;
  requiredTitle: string;
  optionalTitle: string;
  termsAcceptanceLabel: string;
  privacyAcceptanceLabel: string;
  waiverAcceptanceLabel: string;
  mediaAcceptanceLabel: string;
  clubInfoAcceptanceLabel: string;
  minorNotice: string;
};

type LegalTexts = {
  footerPrivacyLabel: string;
  footerImprintLabel: string;
  footerTermsLabel: string;
  footerWaiverLabel: string;
  guardianSectionTitle: string;
  guardianFullNameLabel: string;
  guardianEmailLabel: string;
  guardianPhoneLabel: string;
  guardianConsentLabel: string;
  legalPageBackLabel: string;
  summary: SummaryTexts;
  docs: Record<LegalDocId, LegalDoc>;
};

function normalizeForHash(value: string): string {
  return value.replace(/\r/g, "").replace(/\u00a0/g, " ").trim();
}

function flattenDoc(doc: LegalDoc): string {
  return [
    doc.title,
    ...(doc.intro ?? []),
    ...doc.sections.flatMap((section) => [section.title, ...(section.paragraphs ?? []), ...(section.bullets ?? [])])
  ].join("\n");
}

const privacyDocDe: LegalDoc = {
  id: "datenschutz",
  title: "Datenschutzhinweise",
  summaryLinkLabel: "Datenschutzhinweise",
  sections: [
    {
      title: "1. Verantwortlicher",
      paragraphs: [
        "MSC Oberlausitzer Dreiländereck e.V.",
        "Am Weiher 4",
        "02791 Oderwitz",
        "E-Mail: info@msc-oberlausitzer-dreilaendereck.eu",
        "Vertreten durch den 1. Vorsitzenden Herrn Peter Liersch."
      ]
    },
    {
      title: "2. Zwecke der Verarbeitung",
      paragraphs: [
        "Wir verarbeiten die im Rahmen der Online-Anmeldung angegebenen personenbezogenen Daten, um Ihre Teilnahme organisatorisch und rechtlich abzuwickeln. Dies umfasst insbesondere:"
      ],
      bullets: [
        "Bearbeitung und Prüfung der Anmeldung",
        "Zuordnung zu Klassen und Startfeldern",
        "Teilnehmerverwaltung",
        "Kommunikation mit Teilnehmern, einschließlich E-Mail-Verifikation und Veranstaltungsinformationen",
        "Erstellung und Bereitstellung veranstaltungsbezogener Unterlagen",
        "Durchführung organisatorischer, technischer und sportlicher Abläufe",
        "Dokumentation der Veranstaltung",
        "Abrechnung, Zahlungserfassung und Nachweisführung",
        "Geltendmachung, Ausübung oder Verteidigung rechtlicher Ansprüche"
      ]
    },
    {
      title: "3. Verarbeitete Daten",
      paragraphs: [
        "Je nach Eingabe und Verfahrensschritt verarbeiten wir insbesondere:"
      ],
      bullets: [
        "Vorname und Nachname",
        "Geburtsdatum",
        "Anschrift",
        "Land",
        "E-Mail-Adresse",
        "Telefonnummer",
        "Angaben zum Notfallkontakt",
        "Angaben zum Fahrzeug, zur Klasse und zur Nennung",
        "veranstaltungsbezogene Erklärungen und Bestätigungen",
        "bei Minderjährigen Angaben zum gesetzlichen Vertreter",
        "Status- und Verfahrensdaten zu Verifikation, Check-in, Technik, Zahlung und Dokumenten",
        "Consent-Nachweise wie Consent-Version, Text-Hash, Locale, Quelle und Erfassungszeitpunkt",
        "Upload- und Dokumentmetadaten für Fahrzeugbilder und generierte PDFs",
        "Kommunikations- und Zustelldaten aus E-Mail-Outbox und Zustellnachweisen",
        "Audit- und Betriebsdaten, soweit sie zur sicheren und nachvollziehbaren Bereitstellung der Anwendung erforderlich sind"
      ]
    },
    {
      title: "4. Rechtsgrundlagen",
      paragraphs: [
        "Die Verarbeitung erfolgt insbesondere auf Grundlage von:"
      ],
      bullets: [
        "Art. 6 Abs. 1 lit. b DSGVO zur Durchführung vorvertraglicher Maßnahmen und zur Teilnahmeabwicklung",
        "Art. 6 Abs. 1 lit. c DSGVO zur Erfüllung rechtlicher Verpflichtungen",
        "Art. 6 Abs. 1 lit. f DSGVO für berechtigte Interessen des Veranstalters an einer geordneten Organisation, Dokumentation und sicheren Durchführung der Veranstaltung",
        "Art. 6 Abs. 1 lit. a DSGVO soweit Sie eine freiwillige Einwilligung erteilen, insbesondere für Foto-/Videoveröffentlichungen oder Vereinsinformationen"
      ]
    },
    {
      title: "5. Pflichtangaben und freiwillige Angaben",
      paragraphs: [
        "Die für die Durchführung der Anmeldung erforderlichen Daten sind als Pflichtfelder gekennzeichnet. Ohne diese Angaben kann die Anmeldung in der Regel nicht bearbeitet werden. Freiwillige Angaben und optionale Einwilligungen haben grundsätzlich keinen Einfluss auf die Möglichkeit der Teilnahme, soweit sie nicht ausnahmsweise für die Veranstaltungsdurchführung erforderlich sind."
      ]
    },
    {
      title: "6. Empfänger und Auftragsverarbeiter",
      paragraphs: [
        "Ihre Daten werden nur den Stellen zugänglich gemacht, die sie für die Durchführung und Abwicklung der Veranstaltung benötigen. Hierzu gehören insbesondere:",
        "Als technische Auftragsverarbeiter werden nach aktuellem Systemzuschnitt insbesondere AWS-Dienste in der Region eu-central-1 eingesetzt, darunter:"
      ],
      bullets: [
        "interne zuständige Stellen des Vereins",
        "mit der Organisation und Durchführung beauftragte Funktionsträger",
        "technische Dienstleister und Auftragsverarbeiter",
        "Verbände, Versicherungen oder sonstige Stellen, soweit dies für die Durchführung oder rechtliche Abwicklung erforderlich ist",
        "AWS RDS PostgreSQL für transaktionale Datenspeicherung",
        "AWS S3 für Dokumente, Upload-Artefakte und Fahrzeugbilder",
        "AWS SES für E-Mail-Zustellung",
        "AWS Cognito für Admin-Authentisierung und Autorisierung",
        "AWS CloudWatch für Betriebs- und Sicherheitslogging",
        "AWS Lambda, EventBridge, API Gateway und Secrets Manager als Ausführungs- und Infrastrukturkomponenten"
      ]
    },
    {
      title: "7. Hosting, Kommunikation und technische Verarbeitung",
      paragraphs: [
        "Die Online-Anmeldung wird technisch über eine Webanwendung mit Backend, Datenbank, Dateiablage und E-Mail-Kommunikation bereitgestellt. Im Rahmen der Nutzung werden auch Verifikationsdaten, Idempotenzdaten, Export- und Dokumentmetadaten sowie technische Log- und Auditdaten verarbeitet, soweit dies für den sicheren Betrieb, Missbrauchsschutz, Nachweiszwecke und die Abwicklung des Verfahrens erforderlich ist.",
        "Marketing- oder Tracking-Cookies werden im Anmeldeformular nicht eingesetzt. Es werden nur technisch notwendige Speicher- und Sicherheitsmechanismen verwendet."
      ]
    },
    {
      title: "8. Speicherdauer",
      paragraphs: [
        "Personenbezogene Daten werden nur so lange gespeichert, wie dies für die Durchführung und Nachbereitung der Veranstaltung, zur Erfüllung rechtlicher Pflichten oder zur Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen erforderlich ist. Personenbezogene Daten aus der Anmeldung werden grundsätzlich bis ein Jahr nach Veranstaltungsende gespeichert und anschließend gelöscht oder anonymisiert, soweit keine gesetzlichen Aufbewahrungspflichten oder rechtlichen Gründe einer weiteren Speicherung entgegenstehen. Es gelten insbesondere folgende Fristen:"
      ],
      bullets: [
        "Personenbezogene Daten aus der Anmeldung: 1 Jahr nach Veranstaltungsende",
        "Notizen und Angaben zu Sorgeberechtigten bei Minderjährigen: 1 Jahr nach Veranstaltungsende",
        "Verifikationsdaten und Idempotenzdaten: 30 Tage",
        "Upload-Metadaten: 30 Tage nach Abschluss oder Verfall",
        "Dokumentmetadaten und PDF-Unterlagen: 6 Jahre nach Veranstaltungsende",
        "Rechnungs- und Zahlungsdaten: 10 Jahre nach Veranstaltungsende",
        "E-Mail-Outbox- und Zustelldaten: 12 Monate",
        "Exportdaten: 90 Tage",
        "Audit-Log-Daten: 24 Monate",
        "CloudWatch-Anwendungslogs: 30 Tage, sicherheitsrelevante Logs bis zu 90 Tage"
      ]
    },
    {
      title: "9. Foto- und Videoaufnahmen",
      paragraphs: [
        "Soweit Foto- oder Videoaufnahmen verarbeitet werden, erfolgt dies entweder auf Grundlage Ihrer gesonderten Einwilligung oder auf einer anderen gesetzlich zulässigen Rechtsgrundlage im Zusammenhang mit Veranstaltungsdokumentation und Öffentlichkeitsarbeit. Eine erteilte Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen."
      ]
    },
    {
      title: "10. Vereinsinformationen",
      paragraphs: [
        "Sofern Sie gesondert eingewilligt haben, verwenden wir Ihre Kontaktdaten, um Sie über Vereinsinformationen, künftige Veranstaltungen oder organisatorische Hinweise zu informieren. Diese Einwilligung ist freiwillig und jederzeit mit Wirkung für die Zukunft widerruflich."
      ]
    },
    {
      title: "11. Ihre Rechte",
      paragraphs: [
        "Sie haben nach Maßgabe der gesetzlichen Voraussetzungen das Recht auf:"
      ],
      bullets: [
        "Auskunft",
        "Berichtigung",
        "Löschung",
        "Einschränkung der Verarbeitung",
        "Widerspruch gegen die Verarbeitung",
        "Datenübertragbarkeit",
        "Widerruf erteilter Einwilligungen mit Wirkung für die Zukunft"
      ]
    },
    {
      title: "12. Beschwerderecht",
      paragraphs: [
        "Sie haben das Recht, sich bei einer Datenschutzaufsichtsbehörde zu beschweren.",
        "Eine automatisierte Entscheidungsfindung einschließlich Profiling findet nicht statt."
      ]
    }
  ]
};

const imprintDocDe: LegalDoc = {
  id: "impressum",
  title: "Impressum",
  summaryLinkLabel: "Impressum",
  sections: [
    {
      title: "Angaben gemäß § 5 DDG",
      paragraphs: [
        "MSC Oberlausitzer Dreiländereck e.V.",
        "Am Weiher 4",
        "02791 Oderwitz"
      ]
    },
    {
      title: "Vertreten durch den Vorstand",
      paragraphs: ["Peter Liersch, 1. Vorsitzender"]
    },
    {
      title: "Kontakt",
      paragraphs: [
        "E-Mail: info@msc-oberlausitzer-dreilaendereck.eu",
        "Telefon: auf Anfrage per E-Mail"
      ]
    },
    {
      title: "Vereinsregister",
      paragraphs: ["Registergericht Dresden, Vereinsregister VR 5907"]
    },
    {
      title: "Umsatzsteuer-ID",
      paragraphs: ["DE289954270"]
    },
    {
      title: "Verantwortlich für den Inhalt",
      paragraphs: ["MSC Oberlausitzer Dreiländereck e.V."]
    }
  ]
};

const termsDocDe: LegalDoc = {
  id: "teilnahmebedingungen",
  title: "Teilnahmebedingungen",
  summaryLinkLabel: "Teilnahmebedingungen",
  sections: [
    { title: "1. Geltungsbereich", paragraphs: ["Diese Teilnahmebedingungen gelten für die Online-Anmeldung und Teilnahme an der jeweiligen Veranstaltung des MSC Oberlausitzer Dreiländereck e.V."] },
    { title: "2. Teilnahmevoraussetzungen", paragraphs: ["Teilnahmeberechtigt sind nur Personen, die die jeweils geltenden sportlichen, organisatorischen und persönlichen Voraussetzungen erfüllen. Der Veranstalter behält sich vor, Anmeldungen abzulehnen, wenn Voraussetzungen nicht erfüllt sind oder sicherheitsrelevante Gründe entgegenstehen."] },
    { title: "3. Richtigkeit der Angaben", paragraphs: ["Der Teilnehmer versichert, dass alle im Rahmen der Anmeldung gemachten Angaben richtig, vollständig und aktuell sind. Änderungen sind dem Veranstalter unverzüglich mitzuteilen."] },
    { title: "4. Fahrzeug und Eigenverantwortung", paragraphs: ["Der Teilnehmer bestätigt, dass das eingesetzte Fahrzeug den geltenden technischen Anforderungen entspricht und sich in einem ordnungsgemäßen Zustand befindet. Für die technische Sicherheit des Fahrzeugs ist der Teilnehmer selbst verantwortlich."] },
    { title: "5. Gesundheitliche Eignung", paragraphs: ["Der Teilnehmer bestätigt, den Anforderungen der Veranstaltung gesundheitlich gewachsen zu sein. Soweit nach den Veranstaltungsunterlagen zusätzliche Nachweise erforderlich sind, sind diese fristgerecht vorzulegen."] },
    { title: "6. Anerkennung der Veranstaltungsregeln", paragraphs: ["Mit der Anmeldung erkennt der Teilnehmer die Ausschreibung, die ergänzenden Veranstaltungsregeln, behördlichen Vorgaben, Sicherheitsanweisungen und Entscheidungen der Veranstaltungsleitung als verbindlich an."] },
    { title: "7. Minderjährige", paragraphs: ["Minderjährige Teilnehmer dürfen nur mit Zustimmung eines gesetzlichen Vertreters teilnehmen. Der Veranstalter ist berechtigt, eine schriftliche Einverständniserklärung oder weitere Nachweise zu verlangen."] },
    { title: "8. Verhaltenspflichten", paragraphs: ["Den Anweisungen des Veranstalters, der Funktionsträger, Streckenposten, technischen Kommissare und sonstigen beauftragten Personen ist Folge zu leisten. Sicherheitswidriges Verhalten kann zum Ausschluss von der Veranstaltung führen."] },
    { title: "9. Verbotene Handlungen", paragraphs: ["Unzulässige, gefährdende oder den Veranstaltungszweck beeinträchtigende Handlungen sind untersagt. Hierzu zählt insbesondere das Verhalten, das zu vermeidbaren Gefahren, Schäden oder Störungen auf dem Veranstaltungsgelände führt."] },
    { title: "10. Nenngeld und Absage", paragraphs: ["Die Regelungen zu Nenngeld, Zahlungsweise, Rücktritt und Absage der Veranstaltung ergeben sich aus der Ausschreibung oder den ergänzenden Veranstaltungsinformationen. Soweit dort nichts Abweichendes geregelt ist, gelten die vom Veranstalter bekannt gegebenen Bedingungen."] },
    { title: "11. Haftungsverzicht", paragraphs: ["Ergänzend gilt der gesondert bereitgestellte Haftungsverzicht. Dieser ist Bestandteil der Veranstaltungsunterlagen und vor Ort verbindlich zu unterzeichnen."] },
    { title: "12. Datenschutz", paragraphs: ["Informationen zur Verarbeitung personenbezogener Daten finden sich in den gesonderten Datenschutzhinweisen."] }
  ]
};

const waiverDocDe: LegalDoc = {
  id: "haftverzicht",
  title: "Haftverzicht",
  summaryLinkLabel: "Haftverzicht",
  intro: [
    "Der nachfolgende Haftverzicht dient der Vorabinformation im Rahmen der Online-Anmeldung. Maßgeblich ist die bei der Veranstaltung vor Ort zu unterzeichnende Fassung. Mit der Online-Anmeldung bestätigt der Teilnehmer, den Haftungsverzicht zur Kenntnis genommen zu haben.",
    "Der Teilnehmer nimmt zur Kenntnis, dass die Teilnahme an der Veranstaltung auf eigene Verantwortung erfolgt und ergänzend die vor Ort ausgehändigte beziehungsweise bereitgestellte Haftungsverzichtserklärung verbindlich zu unterzeichnen ist."
  ],
  sections: [
    { title: "1. Teilnahme auf eigene Gefahr", paragraphs: ["Die Teilnahme an der Veranstaltung erfolgt auf eigene Gefahr. Der Teilnehmer trägt die zivil- und strafrechtliche Verantwortung für alle von ihm oder dem eingesetzten Fahrzeug verursachten Schäden, soweit kein wirksamer Haftungsausschluss entgegensteht."] },
    { title: "2. Eigenverantwortung und Fahrzeugzustand", paragraphs: ["Der Teilnehmer bestätigt, dass seine Angaben im Rahmen der Anmeldung richtig und vollständig sind, das Fahrzeug den technischen Anforderungen entspricht und in technisch sowie optisch ordnungsgemäßem Zustand eingesetzt wird."] },
    { title: "3. Verzicht auf Ansprüche", paragraphs: ["Mit der Online-Anmeldung nimmt der Teilnehmer zur Kenntnis, dass im Zusammenhang mit der Veranstaltung auf Ansprüche wegen Schäden jeder Art insbesondere gegenüber dem Veranstalter, beteiligten Verbänden, Funktionsträgern, Helfern sowie sonstigen mit Organisation und Durchführung befassten Personen verzichtet wird, soweit dies rechtlich zulässig ist."] },
    { title: "4. Geltung für weitere Beteiligte", paragraphs: ["Der Haftungsverzicht erfasst auch Ansprüche gegenüber anderen Teilnehmern, deren Helfern, Eigentümern anderer Fahrzeuge sowie gegenüber eigenen Helfern des Teilnehmers."] },
    { title: "5. Ausnahmen vom Haftungsausschluss", paragraphs: ["Nicht vom Haftungsverzicht erfasst sind Ansprüche wegen Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit sowie Ansprüche, die auf vorsätzlichem oder grob fahrlässigem Verhalten beruhen."] },
    { title: "6. Ergänzende Veranstaltungsregelungen", paragraphs: ["Der Teilnehmer bestätigt die Kenntnis der Ausschreibungsbedingungen, ergänzender Veranstaltungsregeln, behördlicher Vorgaben und Sicherheitsanweisungen. Bei Absage der Veranstaltung aufgrund höherer Gewalt oder behördlicher Maßnahmen können Rückerstattungsansprüche ausgeschlossen sein, soweit dies in den Veranstaltungsunterlagen geregelt ist."] },
    { title: "7. Verbindliche Unterzeichnung vor Ort", paragraphs: ["Maßgeblich bleibt die bei der Veranstaltung vor Ort zu unterzeichnende Fassung des Haftungsverzichts."] }
  ]
};

const privacyDocEn: LegalDoc = {
  id: "datenschutz",
  title: "Privacy Notice",
  summaryLinkLabel: "Privacy Notice",
  sections: [
    { title: "1. Controller", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz", "E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Represented by the chairman Peter Liersch."] },
    { title: "2. Purpose of processing", paragraphs: ["We process the personal data provided during online registration to organize and legally handle your participation in the event. This includes in particular:"], bullets: ["reviewing and processing the registration", "assigning participants to classes and start fields", "participant management", "communication with participants, including e-mail verification and event messages", "preparing event-related documents", "handling organizational, technical and sporting processes", "documenting the event", "billing, payment tracking and evidence duties", "asserting, exercising or defending legal claims"] },
    { title: "3. Processed data", paragraphs: ["Depending on the process step, we process in particular:"], bullets: ["first and last name", "date of birth", "address and country", "e-mail address", "phone number", "emergency contact details", "vehicle, class and entry details", "event-related declarations and confirmations", "legal guardian details for minors", "status and process data for verification, check-in, technical inspection, payment and documents", "consent evidence such as consent version, text hash, locale, source and capture timestamp", "upload and document metadata for vehicle images and generated PDFs", "communication and delivery data from e-mail outbox and delivery records", "audit and operational data required for secure and traceable operation of the application"] },
    { title: "4. Legal bases", paragraphs: ["Processing is based in particular on:"], bullets: ["Art. 6(1)(b) GDPR for pre-contractual measures and participation handling", "Art. 6(1)(c) GDPR for legal obligations", "Art. 6(1)(f) GDPR for the organizer's legitimate interests in orderly organization, documentation and safe event execution", "Art. 6(1)(a) GDPR where you provide voluntary consent, especially for photo/video publications or club information", "No automated decision-making including profiling takes place."] },
    { title: "5. Mandatory and voluntary information", paragraphs: ["Data required to process the registration are marked as mandatory. Without them, the registration usually cannot be processed. Voluntary information and optional consents normally do not affect participation."] },
    { title: "6. Recipients of the data", paragraphs: ["Your data are made accessible only to the bodies that need them for the event. This includes in particular internal club teams, appointed function holders, technical service providers and processors, and associations, insurers or other bodies where required for execution or legal handling."] },
    { title: "7. Hosting and technical processing", paragraphs: ["The registration platform is operated with technical service providers. AWS services in region eu-central-1 are used in particular for RDS PostgreSQL, S3, SES, Cognito, CloudWatch, Lambda, EventBridge, API Gateway and Secrets Manager."] },
    { title: "8. Retention period", paragraphs: ["Personal data are stored only as long as necessary for the event, legal obligations or legal claims. Personal data from the registration are generally stored until one year after the end of the event and are then deleted or anonymized unless statutory retention obligations or legal reasons require longer storage. In particular, personal registration data are kept for 1 year after the event, notes and legal guardian details for minors for 1 year, verification and idempotency data for 30 days, document metadata and PDFs for 6 years after the event, billing and payment records for 10 years after the event, e-mail outbox and delivery data for 12 months, export data for 90 days and audit data for 24 months."] },
    { title: "9. Photo and video recordings", paragraphs: ["Where photo or video recordings are processed, this is done either on the basis of your separate consent or on another legally permissible basis in connection with documentation and public relations. Consent can be withdrawn at any time for future processing."] },
    { title: "10. Club information", paragraphs: ["If you consent separately, we use your contact data to inform you about club information, future events or organizational notices. This consent is voluntary and can be withdrawn at any time with effect for the future."] },
    { title: "11. Your rights", paragraphs: ["Subject to the statutory requirements, you have the right to access, rectification, erasure, restriction of processing, objection, data portability and withdrawal of consent with effect for the future."] },
    { title: "12. Right to lodge a complaint", paragraphs: ["You have the right to lodge a complaint with a data protection supervisory authority."] }
  ]
};

const imprintDocEn: LegalDoc = {
  id: "impressum",
  title: "Imprint",
  summaryLinkLabel: "Imprint",
  sections: [
    { title: "Information according to Section 5 DDG", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz"] },
    { title: "Represented by the board", paragraphs: ["Peter Liersch, chairman"] },
    { title: "Contact", paragraphs: ["E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Phone: on request by e-mail"] },
    { title: "Association register", paragraphs: ["Register court Dresden, association register VR 5907"] },
    { title: "VAT ID", paragraphs: ["DE289954270"] },
    { title: "Responsible for content", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V."] }
  ]
};

const termsDocEn: LegalDoc = {
  id: "teilnahmebedingungen",
  title: "Participation Terms",
  summaryLinkLabel: "Participation Terms",
  sections: [
    { title: "1. Scope", paragraphs: ["These participation terms apply to online registration and participation in the respective event organized by MSC Oberlausitzer Dreiländereck e.V."] },
    { title: "2. Eligibility", paragraphs: ["Only persons who meet the applicable sporting, organizational and personal requirements are eligible to participate. The organizer may reject registrations if requirements are not met or if safety-related reasons speak against participation."] },
    { title: "3. Accuracy of information", paragraphs: ["The participant assures that all information provided during registration is correct, complete and up to date. Changes must be communicated to the organizer without undue delay."] },
    { title: "4. Vehicle and personal responsibility", paragraphs: ["The participant confirms that the vehicle used complies with the applicable technical requirements and is in proper condition. The participant is responsible for the vehicle's technical safety."] },
    { title: "5. Health suitability", paragraphs: ["The participant confirms being physically fit enough for the requirements of the event. Where additional documents are required under the event documents, they must be submitted in due time."] },
    { title: "6. Acceptance of event rules", paragraphs: ["By registering, the participant accepts the official event announcement, supplementary regulations, governmental requirements, safety instructions and decisions of the event management as binding."] },
    { title: "7. Minors", paragraphs: ["Minor participants may only take part with the consent of a legal representative. The organizer may request written consent or further proof."] },
    { title: "8. Conduct obligations", paragraphs: ["Instructions from the organizer, function holders, marshals, technical commissioners and other appointed persons must be followed. Unsafe conduct may lead to exclusion from the event."] },
    { title: "9. Prohibited conduct", paragraphs: ["Actions that are impermissible, dangerous or incompatible with the purpose of the event are prohibited. This includes conduct causing avoidable dangers, damage or disruptions on the event site."] },
    { title: "10. Entry fee and cancellation", paragraphs: ["Rules on entry fee, payment, withdrawal and event cancellation follow from the event announcement or supplementary information. Where nothing else is specified there, the conditions published by the organizer apply."] },
    { title: "11. Waiver", paragraphs: ["The separately provided waiver applies in addition. It is part of the event documents and must be signed on site in binding form."] },
    { title: "12. Data protection", paragraphs: ["Information on the processing of personal data is provided in the separate privacy notice."] }
  ]
};

const waiverDocEn: LegalDoc = {
  id: "haftverzicht",
  title: "Waiver",
  summaryLinkLabel: "Waiver",
  intro: [
    "This waiver is provided in advance for online registration. The binding version is the waiver document to be signed on site during the event. The online registration only confirms that the participant has taken note of it.",
    "The participant acknowledges that participation in the event takes place under personal responsibility and that the waiver made available on site must additionally be signed in binding form."
  ],
  sections: [
    { title: "1. Participation at own risk", paragraphs: ["Participation in the event is at the participant's own risk. The participant bears civil and criminal responsibility for all damage caused by the participant or the vehicle used, unless an effective exclusion of liability applies."] },
    { title: "2. Personal responsibility and vehicle condition", paragraphs: ["The participant confirms that all registration information is correct and complete, that the vehicle complies with the technical requirements and is used in proper technical and visual condition."] },
    { title: "3. Waiver of claims", paragraphs: ["By registering online, the participant acknowledges that, in connection with the event, claims for damages of any kind are waived to the extent legally permissible, in particular against the organizer, involved associations, officials, helpers and other persons involved in organization and execution."] },
    { title: "4. Scope towards further parties", paragraphs: ["The waiver also covers claims against other participants, their helpers, owners of other vehicles and the participant's own helpers."] },
    { title: "5. Exceptions from the waiver", paragraphs: ["The waiver does not cover claims for injury to life, body or health, or claims based on intentional or grossly negligent conduct."] },
    { title: "6. Additional event rules", paragraphs: ["The participant confirms awareness of the official event regulations, supplementary rules, governmental requirements and safety instructions. If the event is cancelled due to force majeure or official measures, refund claims may be excluded insofar as this is provided for in the event documents."] },
    { title: "7. Binding signature on site", paragraphs: ["The binding version remains the waiver document to be signed on site during registration."] }
  ]
};

const privacyDocCz: LegalDoc = {
  id: "datenschutz",
  title: "Informace o ochrane osobnich udaju",
  summaryLinkLabel: "Informace o ochrane osobnich udaju",
  sections: [
    { title: "1. Spravce", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz", "E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Zastoupen predseda Peterem Lierschem."] },
    { title: "2. Ucel zpracovani", paragraphs: ["Osobni udaje uvedene v online registraci zpracovavame pro organizacni a pravni vyrizeni ucasti na akci. To zahrnuje zejmena kontrolu registrace, prirazeni do trid a startovnich poli, spravu ucastniku, komunikaci vcetne e-mailove verifikace, pripravu dokumentu, organizacni, technicke a sportovni procesy, dokumentaci akce, vyuctovani a obhajobu pravnich naroku."] },
    { title: "3. Zpracovavane udaje", paragraphs: ["Zpracovavame zejmena jmeno a prijmeni, datum narozeni, adresu, narodnost, e-mail, telefon, nouzovy kontakt, udaje o vozidle, tride a registraci, potrebna prohlaseni a potvrzeni, u nezletilych udaje zakonneho zastupce, procesni a stavove udaje k verifikaci, check-inu, technicke kontrole, platbam a dokumentum, zaznamy o souhlasech, metadata uploadu a dokumentu i komunikacni a auditni data nezbytna pro bezpecny provoz aplikace."] },
    { title: "4. Pravni zaklady", paragraphs: ["Pravnimi zaklady jsou zejmena cl. 6 odst. 1 pism. b GDPR, cl. 6 odst. 1 pism. c GDPR, cl. 6 odst. 1 pism. f GDPR a v pripade dobrovolnych souhlasu cl. 6 odst. 1 pism. a GDPR. Automatizovane rozhodovani ani profilovani neprobiha."] },
    { title: "5. Povinne a dobrovolne udaje", paragraphs: ["Udaje potrebne pro registraci jsou oznaceny jako povinne. Bez nich nelze registraci zpravidla zpracovat. Dobrovolne udaje a volitelne souhlasy nejsou podminkou ucasti."] },
    { title: "6. Prijemci udaju", paragraphs: ["Udaje jsou pristupne pouze osobam a subjektum, ktere je potrebuji pro organizaci akce, zejmena internim klubovym rolim, poverenym organizacnim funkcionarum, technickym zpracovatelum a dalsim subjektum, pokud je to nezbytne pro provedeni nebo pravni vyrizeni akce."] },
    { title: "7. Hosting a technicke zpracovani", paragraphs: ["Pro provoz platformy se vyuzivaji technicke sluzby AWS v regionu eu-central-1, zejmena RDS PostgreSQL, S3, SES, Cognito, CloudWatch, Lambda, EventBridge, API Gateway a Secrets Manager."] },
    { title: "8. Doba uchovani", paragraphs: ["Osobni udaje se uchovavaji jen po dobu nezbytnou pro akci, pravni povinnosti a pripadne pravni naroky. Osobni udaje z registrace se zpravidla uchovavaji do jednoho roku po skonceni akce a pote se vymazou nebo anonymizuji, pokud delsi uchovani nevyplyva ze zakonne povinnosti nebo pravniho duvodu. Konkretne se osobni udaje z registrace uchovavaji 1 rok po skonceni akce, poznamky a udaje o zakonnych zastupcich nezletilych 1 rok, verifikacni a idempotencni data 30 dni, metadata dokumentu a PDF 6 let po skonceni akce, ucetni a platebni data 10 let po skonceni akce, e-mailova outbox a delivery data 12 mesicu, exporty 90 dni a auditni data 24 mesicu."] },
    { title: "9. Foto a video zaznamy", paragraphs: ["Pokud jsou zpracovavany foto nebo video zaznamy, deje se tak bud na zaklade samostatneho souhlasu, nebo na jinem zakonem pripustnem zaklade. Souhlas lze kdykoli odvolat s ucinky do budoucna."] },
    { title: "10. Klubove informace", paragraphs: ["Pokud udelite samostatny souhlas, budou vase kontaktni udaje vyuzity pro informace o klubu, budouci akce a organizacni oznameni. Tento souhlas je dobrovolny a lze jej kdykoli odvolat."] },
    { title: "11. Vasa prava", paragraphs: ["Mate pravo na pristup, opravu, vymaz, omezeni zpracovani, namitku, prenositelnost udaju a odvolani souhlasu s ucinky do budoucna."] },
    { title: "12. Pravo podat stiznost", paragraphs: ["Mate pravo podat stiznost u dozoru nad ochranou osobnich udaju."] }
  ]
};

const imprintDocCz: LegalDoc = {
  id: "impressum",
  title: "Impressum",
  summaryLinkLabel: "Impressum",
  sections: [
    { title: "Udaje podle § 5 DDG", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz"] },
    { title: "Zastoupeni predstavenstvem", paragraphs: ["Peter Liersch, predseda"] },
    { title: "Kontakt", paragraphs: ["E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Telefon: na vyzadani e-mailem"] },
    { title: "Registrace sdruzeni", paragraphs: ["Registracni soud Dresden, VR 5907"] },
    { title: "DIC", paragraphs: ["DE289954270"] },
    { title: "Odpovednost za obsah", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V."] }
  ]
};

const termsDocCz: LegalDoc = {
  id: "teilnahmebedingungen",
  title: "Podminky ucasti",
  summaryLinkLabel: "Podminky ucasti",
  sections: [
    { title: "1. Rozsah", paragraphs: ["Tyto podminky plati pro online registraci a ucast na prislusne akci MSC Oberlausitzer Dreiländereck e.V."] },
    { title: "2. Predpoklady ucasti", paragraphs: ["Ucastnit se mohou pouze osoby splnujici sportovni, organizacni a osobni predpoklady. Poradatel muze registraci odmitnout, pokud podminky nejsou splneny nebo pokud existuji bezpecnostni duvody proti ucasti."] },
    { title: "3. Spravnost udaju", paragraphs: ["Ucastnik potvrzuje, ze vsechny udaje v registraci jsou spravne, uplne a aktualni. Zmeny je treba neprodlene oznamit poradatelovi."] },
    { title: "4. Vozidlo a vlastni odpovednost", paragraphs: ["Ucastnik potvrzuje, ze pouzite vozidlo odpovida technickym pozadavkum a je v radnem stavu. Za technickou bezpecnost vozidla odpovida sam ucastnik."] },
    { title: "5. Zdravotni zpusobilost", paragraphs: ["Ucastnik potvrzuje, ze zdravotne zvladne naroky akce. Pokud jsou podle podkladu akce vyzadovany dalsi doklady, musi byt predlozeny vcas."] },
    { title: "6. Uznavani pravidel", paragraphs: ["Registraci ucastnik uznava zavaznost oficialniho vypsani akce, doplnkovych pravidel, urednich pozadavku, bezpecnostnich pokynu a rozhodnuti vedeni akce."] },
    { title: "7. Nezletili", paragraphs: ["Nezletili ucastnici mohou startovat pouze se souhlasem zakonneho zastupce. Poradatel muze vyzadovat pisemny souhlas nebo dalsi doklady."] },
    { title: "8. Povinnosti chovani", paragraphs: ["Pokynum poradatele, funkcionaru, tratovych poradatelu, technickych komisaru a dalsich poverenych osob je nutne vyhovet. Nebezpecne chovani muze vest k vylouceni z akce."] },
    { title: "9. Zakazane jednani", paragraphs: ["Zakazany jsou cinnosti, ktere jsou nepripustne, nebezpecne nebo odporuji ucelu akce. To zahrnuje jednani vedouci k zbytecnemu nebezpeci, skodam nebo naruseni prostoru akce."] },
    { title: "10. Startovne a zruseni", paragraphs: ["Pravidla pro startovne, platbu, odstoupeni a zruseni akce vyplyvaji z oficialniho vypsani nebo dalsich informaci poradatele."] },
    { title: "11. Prohlaseni o vzdani se odpovednosti", paragraphs: ["Samostatne poskytnute prohlaseni o vzdani se odpovednosti plati doplnkove. Je soucasti dokumentace k akci a zavazne se podepisuje na miste."] },
    { title: "12. Ochrana osobnich udaju", paragraphs: ["Informace o zpracovani osobnich udaju jsou uvedeny v samostatnych informacich o ochrane osobnich udaju."] }
  ]
};

const waiverDocCz: LegalDoc = {
  id: "haftverzicht",
  title: "Prohlaseni o vzdani se odpovednosti",
  summaryLinkLabel: "Prohlaseni o vzdani se odpovednosti",
  intro: [
    "Tento text slouzi jako predbezna informace pro online registraci. Zavazna je verze, ktera se podepisuje osobne pri akci. Online registrace potvrzuje pouze to, ze se ucastnik s textem seznamil.",
    "Ucastnik bere na vedomi, ze ucast na akci probiha na vlastni odpovednost a ze prohlaseni poskytnute na miste musi byt podepsano v zavazne forme."
  ],
  sections: [
    { title: "1. Ucast na vlastni nebezpeci", paragraphs: ["Ucast na akci probiha na vlastni nebezpeci ucastnika. Ucastnik nese obcanskopravni i trestnepravni odpovednost za skody zpusobene jim nebo pouzitym vozidlem, pokud neplati ucinne vylouceni odpovednosti."] },
    { title: "2. Vlastni odpovednost a stav vozidla", paragraphs: ["Ucastnik potvrzuje, ze vsechny udaje v registraci jsou spravne a uplne, vozidlo splnuje technicke pozadavky a je pouzito v radnem technickem i vizualnim stavu."] },
    { title: "3. Vzdani se naroku", paragraphs: ["Odeslanim online registrace ucastnik bere na vedomi, ze v souvislosti s akci se v rozsahu pripustnem pravem vzdava naroku na nahradu skody zejmena vuci poradatelum, zapojenym svazum, funkcionarum, pomocnikum a dalsim osobam podilejicim se na organizaci a prubehu akce."] },
    { title: "4. Rozsireni na dalsi osoby", paragraphs: ["Vzdani se naroku se vztahuje i na dalsi ucastniky, jejich pomocniky, vlastniky jinych vozidel a vlastni pomocniky ucastnika."] },
    { title: "5. Vyjimky z vylouceni odpovednosti", paragraphs: ["Prohlaseni se nevztahuje na naroky pri ujme na zivote, tele nebo zdravi ani na naroky zalozene na umyslnem nebo hrube nedbalostnim jednani."] },
    { title: "6. Dalsi pravidla akce", paragraphs: ["Ucastnik potvrzuje znalost oficialnich pravidel akce, doplnkovych podminek, urednich pozadavku a bezpecnostnich pokynu. Pri zruseni akce z duvodu vyssi moci nebo urednich opatreni mohou byt naroky na vraceni poplatku vylouceny, pokud to stanovi podklady k akci."] },
    { title: "7. Zavazny podpis na miste", paragraphs: ["Zavazna zustava verze prohlaseni, ktera se podepisuje osobne pri registraci na miste."] }
  ]
};

const privacyDocPl: LegalDoc = {
  id: "datenschutz",
  title: "Informacja o prywatnosci",
  summaryLinkLabel: "Informacja o prywatnosci",
  sections: [
    { title: "1. Administrator", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz", "E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Reprezentowany przez przewodniczacego Petera Lierscha."] },
    { title: "2. Cel przetwarzania", paragraphs: ["Przetwarzamy dane osobowe podane w formularzu rejestracji online w celu organizacyjnej i prawnej obslugi Twojego udzialu w wydarzeniu. Obejmuje to w szczegolnosci weryfikacje zgloszenia, przypisanie do klas i pol startowych, zarzadzanie uczestnikami, komunikacje wraz z weryfikacja e-mail, przygotowanie dokumentow, obsluge procesow organizacyjnych, technicznych i sportowych, dokumentacje wydarzenia, rozliczenia oraz dochodzenie lub obrone roszczen prawnych."] },
    { title: "3. Zakres danych", paragraphs: ["Przetwarzamy w szczegolnosci imie i nazwisko, date urodzenia, adres, narodowosc, adres e-mail, numer telefonu, dane kontaktu awaryjnego, dane pojazdu, klasy i zgloszenia, wymagane oswiadczenia i potwierdzenia, dane przedstawiciela ustawowego w przypadku osob niepelnoletnich, dane procesowe dotyczace weryfikacji, check-inu, kontroli technicznej, platnosci i dokumentow, zapisy dotyczace zgod, metadane uploadu i dokumentow oraz dane komunikacyjne i audytowe niezbedne do bezpiecznego dzialania aplikacji."] },
    { title: "4. Podstawy prawne", paragraphs: ["Podstawami prawnymi sa w szczegolnosci art. 6 ust. 1 lit. b RODO, art. 6 ust. 1 lit. c RODO, art. 6 ust. 1 lit. f RODO oraz przy dobrowolnych zgodach art. 6 ust. 1 lit. a RODO. Nie dochodzi do zautomatyzowanego podejmowania decyzji ani profilowania."] },
    { title: "5. Dane obowiazkowe i dobrowolne", paragraphs: ["Dane wymagane do obslugi rejestracji sa oznaczone jako obowiazkowe. Bez nich rejestracja z reguly nie moze zostac przetworzona. Dane dobrowolne i zgody pozostaja dobrowolne i nie warunkuja mozliwosci udzialu."] },
    { title: "6. Odbiorcy danych", paragraphs: ["Dane sa udostepniane wyłącznie osobom i podmiotom, ktore potrzebuja ich do organizacji wydarzenia, w szczegolnosci wewnetrznym rolom klubowym, wyznaczonym funkcjonariuszom, technicznym podmiotom przetwarzajacym oraz innym podmiotom, jezeli jest to konieczne do realizacji lub prawnej obslugi wydarzenia."] },
    { title: "7. Hosting i przetwarzanie techniczne", paragraphs: ["Do obslugi platformy wykorzystywane sa uslugi AWS w regionie eu-central-1, w szczegolnosci RDS PostgreSQL, S3, SES, Cognito, CloudWatch, Lambda, EventBridge, API Gateway i Secrets Manager."] },
    { title: "8. Okres przechowywania", paragraphs: ["Dane osobowe przechowujemy tylko tak dlugo, jak jest to konieczne dla wydarzenia, obowiazkow prawnych i ewentualnych roszczen prawnych. Dane osobowe zgloszenia sa co do zasady przechowywane do jednego roku po zakonczeniu wydarzenia, a nastepnie usuwane lub anonimizowane, chyba ze dluzsze przechowywanie wynika z obowiazkow ustawowych lub przyczyn prawnych. W szczegolnosci dane osobowe ze zgloszenia przechowujemy przez 1 rok po zakonczeniu wydarzenia, notatki i dane opiekuna prawnego osoby niepelnoletniej przez 1 rok, dane weryfikacyjne i idempotencyjne przez 30 dni, metadane dokumentow i pliki PDF przez 6 lat po zakonczeniu wydarzenia, dane rozliczeniowe i platnosci przez 10 lat po zakonczeniu wydarzenia, dane outbox i delivery przez 12 miesiecy, eksporty przez 90 dni, a dane audytowe przez 24 miesiace."] },
    { title: "9. Zdjecia i nagrania wideo", paragraphs: ["Jezeli przetwarzane sa zdjecia lub nagrania wideo, odbywa sie to na podstawie odrebnej zgody albo innej dopuszczalnej prawem podstawy. Zgode mozna w kazdym czasie odwolac ze skutkiem na przyszlosc."] },
    { title: "10. Informacje klubowe", paragraphs: ["Jesli wyrazisz odrebna zgode, wykorzystamy Twoje dane kontaktowe do przekazywania informacji klubowych, o przyszlych wydarzeniach i komunikatow organizacyjnych. Zgoda ta jest dobrowolna i moze byc w kazdym czasie odwolana."] },
    { title: "11. Twoje prawa", paragraphs: ["Masz prawo do dostepu, sprostowania, usuniecia, ograniczenia przetwarzania, sprzeciwu, przenoszenia danych oraz cofniecia zgody ze skutkiem na przyszlosc."] },
    { title: "12. Prawo do skargi", paragraphs: ["Masz prawo zlozyc skarge do organu nadzorczego do spraw ochrony danych."] }
  ]
};

const imprintDocPl: LegalDoc = {
  id: "impressum",
  title: "Impressum",
  summaryLinkLabel: "Impressum",
  sections: [
    { title: "Dane zgodnie z § 5 DDG", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V.", "Am Weiher 4", "02791 Oderwitz"] },
    { title: "Reprezentowany przez zarzad", paragraphs: ["Peter Liersch, przewodniczacy"] },
    { title: "Kontakt", paragraphs: ["E-mail: info@msc-oberlausitzer-dreilaendereck.eu", "Telefon: na prosbe przez e-mail"] },
    { title: "Rejestr stowarzyszen", paragraphs: ["Sad rejestrowy Dresden, VR 5907"] },
    { title: "NIP VAT", paragraphs: ["DE289954270"] },
    { title: "Odpowiedzialny za tresc", paragraphs: ["MSC Oberlausitzer Dreiländereck e.V."] }
  ]
};

const termsDocPl: LegalDoc = {
  id: "teilnahmebedingungen",
  title: "Warunki udzialu",
  summaryLinkLabel: "Warunki udzialu",
  sections: [
    { title: "1. Zakres", paragraphs: ["Niniejsze warunki udzialu obowiazuja dla rejestracji online i udzialu w danym wydarzeniu organizowanym przez MSC Oberlausitzer Dreiländereck e.V."] },
    { title: "2. Warunki uczestnictwa", paragraphs: ["Do udzialu uprawnione sa tylko osoby spelniajace obowiazujace wymagania sportowe, organizacyjne i osobiste. Organizator moze odrzucic zgloszenie, jesli wymagania nie sa spelnione albo istnieja wzgledy bezpieczenstwa."] },
    { title: "3. Prawidlowosc danych", paragraphs: ["Uczestnik zapewnia, ze wszystkie dane podane podczas rejestracji sa prawidlowe, kompletne i aktualne. Zmiany nalezy niezwlocznie zglosic organizatorowi."] },
    { title: "4. Pojazd i odpowiedzialnosc wlasna", paragraphs: ["Uczestnik potwierdza, ze wykorzystywany pojazd spelnia wymagania techniczne i znajduje sie we wlasciwym stanie. Za bezpieczenstwo techniczne pojazdu odpowiada sam uczestnik."] },
    { title: "5. Zdolnosc zdrowotna", paragraphs: ["Uczestnik potwierdza, ze jego stan zdrowia pozwala mu sprostac wymaganiom wydarzenia. Jezeli dokumenty wydarzenia wymagaja dodatkowych zaswiadczen, musza one zostac dostarczone w terminie."] },
    { title: "6. Akceptacja zasad wydarzenia", paragraphs: ["Rejestrujac sie, uczestnik uznaje za wiazace oficjalne ogloszenie wydarzenia, dodatkowe regulaminy, wymogi organow, instrukcje bezpieczenstwa oraz decyzje kierownictwa wydarzenia."] },
    { title: "7. Osoby niepelnoletnie", paragraphs: ["Osoby niepelnoletnie moga brac udzial tylko za zgoda przedstawiciela ustawowego. Organizator moze zazadac pisemnej zgody lub dalszych dowodow."] },
    { title: "8. Obowiazki zachowania", paragraphs: ["Nalezy stosowac sie do polecen organizatora, funkcyjnych, sedziow technicznych, porzadkowych i innych upowaznionych osob. Zachowanie niebezpieczne moze prowadzic do wykluczenia z wydarzenia."] },
    { title: "9. Zakazane dzialania", paragraphs: ["Zakazane sa dzialania niedozwolone, niebezpieczne lub sprzeczne z celem wydarzenia. Dotyczy to zwlaszcza zachowan prowadzacych do mozliwych do unikniecia zagrozen, szkod albo zaklocen na terenie wydarzenia."] },
    { title: "10. Oplata startowa i odwolanie", paragraphs: ["Zasady dotyczace oplaty startowej, platnosci, rezygnacji i odwolania wydarzenia wynikaja z oficjalnego ogloszenia lub dodatkowych informacji organizatora."] },
    { title: "11. Zrzeczenie odpowiedzialnosci", paragraphs: ["Dodatkowo obowiazuje odrebnie udostepnione zrzeczenie odpowiedzialnosci. Jest ono czescia dokumentow wydarzenia i musi zostac podpisane na miejscu."] },
    { title: "12. Ochrona danych", paragraphs: ["Informacje o przetwarzaniu danych osobowych znajduja sie w odrebnej informacji o prywatnosci."] }
  ]
};

const waiverDocPl: LegalDoc = {
  id: "haftverzicht",
  title: "Zrzeczenie odpowiedzialnosci",
  summaryLinkLabel: "Zrzeczenie odpowiedzialnosci",
  intro: [
    "Ten tekst sluzy jako wstepna informacja na potrzeby rejestracji online. Wiazaca jest wersja podpisywana osobiscie podczas wydarzenia. Rejestracja online potwierdza jedynie zapoznanie sie z trescia.",
    "Uczestnik przyjmuje do wiadomosci, ze udzial w wydarzeniu odbywa sie na wlasna odpowiedzialnosc i ze dokument udostepniony na miejscu musi zostac dodatkowo podpisany w formie wiazacej."
  ],
  sections: [
    { title: "1. Udzial na wlasne ryzyko", paragraphs: ["Udzial w wydarzeniu odbywa sie na wlasne ryzyko uczestnika. Uczestnik ponosi odpowiedzialnosc cywilna i karna za szkody spowodowane przez siebie lub wykorzystywany pojazd, o ile nie ma zastosowania skuteczne wylaczenie odpowiedzialnosci."] },
    { title: "2. Wlasna odpowiedzialnosc i stan pojazdu", paragraphs: ["Uczestnik potwierdza, ze wszystkie dane podane przy rejestracji sa prawidlowe i kompletne, pojazd spelnia wymagania techniczne i jest uzywany w nalezytym stanie technicznym oraz wizualnym."] },
    { title: "3. Zrzeczenie roszczen", paragraphs: ["Dokonujac rejestracji online, uczestnik przyjmuje do wiadomosci, ze w zwiazku z wydarzeniem zrzeka sie, w zakresie dopuszczalnym przez prawo, roszczen odszkodowawczych w szczegolnosci wobec organizatora, zaangazowanych zwiazkow, funkcjonariuszy, pomocnikow i innych osob uczestniczacych w organizacji oraz przebiegu wydarzenia."] },
    { title: "4. Zakres wobec dalszych osob", paragraphs: ["Zrzeczenie obejmuje rowniez roszczenia wobec innych uczestnikow, ich pomocnikow, wlascicieli innych pojazdow oraz wlasnych pomocnikow uczestnika."] },
    { title: "5. Wyjatki od wykluczenia odpowiedzialnosci", paragraphs: ["Zrzeczenie nie obejmuje roszczen z tytulu naruszenia zycia, ciala lub zdrowia ani roszczen wynikajacych z dzialania umyslnego lub razacego niedbalstwa."] },
    { title: "6. Dodatkowe zasady wydarzenia", paragraphs: ["Uczestnik potwierdza znajomosc oficjalnych regulaminow wydarzenia, dodatkowych zasad, wymogow urzedowych i instrukcji bezpieczenstwa. W razie odwolania wydarzenia z powodu sily wyzszej lub decyzji urzedowych roszczenia o zwrot oplat moga byc wylaczone, jezeli przewiduja to dokumenty wydarzenia."] },
    { title: "7. Wiazacy podpis na miejscu", paragraphs: ["Wiazaca pozostaje wersja oswiadczenia podpisywana osobiscie podczas rejestracji na miejscu."] }
  ]
};

const legalTextsDe: LegalTexts = {
  footerPrivacyLabel: "Datenschutz",
  footerImprintLabel: "Impressum",
  footerTermsLabel: "Teilnahmebedingungen",
  footerWaiverLabel: "Haftverzicht",
  guardianSectionTitle: "Angaben Sorgeberechtigter (bei Fahrern unter 18)",
  guardianFullNameLabel: "Vollständiger Name Sorgeberechtigter",
  guardianEmailLabel: "E-Mail Sorgeberechtigter",
  guardianPhoneLabel: "Telefon Sorgeberechtigter",
  guardianConsentLabel: "Ich bestätige als Sorgeberechtigter die Teilnahme des minderjährigen Fahrers.",
  legalPageBackLabel: "Zurück zur Anmeldung",
  summary: {
    title: "Rechtliche Hinweise und Einwilligungen",
    introTitle: "Hinweise zur Anmeldung",
    introBody: [
      "Mit dem Absenden der Anmeldung verarbeitet der MSC Oberlausitzer Dreiländereck e.V. die von Ihnen angegebenen personenbezogenen Daten zur Durchführung der Veranstaltung, zur Teilnehmerverwaltung, zur Kommunikation im Zusammenhang mit Ihrer Anmeldung, zur Erstellung veranstaltungsbezogener Unterlagen sowie zur organisatorischen und rechtlichen Abwicklung der Teilnahme.",
      "Personenbezogene Daten aus der Anmeldung werden grundsätzlich bis ein Jahr nach Veranstaltungsende gespeichert und anschließend gelöscht oder anonymisiert, soweit keine gesetzlichen Aufbewahrungspflichten oder rechtlichen Gründe einer weiteren Speicherung entgegenstehen.",
      "Rechtsgrundlagen sind insbesondere Art. 6 Abs. 1 lit. b DSGVO für die Teilnahmeabwicklung, Art. 6 Abs. 1 lit. c DSGVO für gesetzliche Pflichten sowie Art. 6 Abs. 1 lit. f DSGVO für berechtigte organisatorische Interessen des Veranstalters. Soweit eine Verarbeitung nicht für die Durchführung der Veranstaltung erforderlich ist, erfolgt sie nur auf Grundlage einer gesonderten Einwilligung.",
      "Weitere Informationen finden Sie in den Datenschutzhinweisen."
    ],
    voluntaryTitle: "Freiwillige Einwilligungen",
    voluntaryBody:
      "Die Einwilligung in Foto- und Videoaufnahmen sowie in den Erhalt von Vereinsinformationen ist freiwillig und kann jederzeit mit Wirkung für die Zukunft widerrufen werden. Die Teilnahme an der Veranstaltung ist nicht von diesen optionalen Einwilligungen abhängig.",
    waiverNoticeTitle: "Wichtiger Hinweis zum Haftungsverzicht",
    waiverNoticeBody:
      "Der Haftungsverzicht ist Bestandteil der Veranstaltungsunterlagen. Die verbindliche Unterschrift erfolgt zusätzlich vor Ort bei der Anmeldung in Schriftform.",
    linksTitle: "Rechtstexte",
    requiredTitle: "Erforderliche Bestätigungen",
    optionalTitle: "Optionale Einwilligungen",
    termsAcceptanceLabel: "Ich habe die Teilnahmebedingungen gelesen und akzeptiere diese.",
    privacyAcceptanceLabel: "Ich habe die Datenschutzhinweise zur Kenntnis genommen.",
    waiverAcceptanceLabel: "Ich bestätige, dass ich den Haftungsverzicht gelesen habe und diesen bei der Anmeldung vor Ort verbindlich unterzeichnen werde.",
    mediaAcceptanceLabel:
      "Ich willige ein, dass während der Veranstaltung angefertigte Foto- und Videoaufnahmen, auf denen ich erkennbar bin, für die Berichterstattung über die Veranstaltung sowie für die Veröffentlichung auf der Website und den Social-Media-Kanälen des MSC Oberlausitzer Dreiländereck e.V. verwendet werden dürfen.",
    clubInfoAcceptanceLabel:
      "Ich willige ein, dass mich der MSC Oberlausitzer Dreiländereck e.V. per E-Mail oder telefonisch über Vereinsinformationen, künftige Veranstaltungen und organisatorische Hinweise kontaktieren darf.",
    minorNotice:
      "Minderjährige dürfen nur mit Zustimmung eines gesetzlichen Vertreters angemeldet werden. Der Veranstalter kann einen entsprechenden Nachweis oder eine zusätzliche Unterschrift verlangen."
  },
  docs: {
    impressum: imprintDocDe,
    datenschutz: privacyDocDe,
    teilnahmebedingungen: termsDocDe,
    haftverzicht: waiverDocDe
  }
};

const legalTextsEn: LegalTexts = {
  footerPrivacyLabel: "Privacy",
  footerImprintLabel: "Imprint",
  footerTermsLabel: "Participation Terms",
  footerWaiverLabel: "Waiver",
  guardianSectionTitle: "Legal guardian details (required for drivers under 18)",
  guardianFullNameLabel: "Legal guardian full name",
  guardianEmailLabel: "Legal guardian email",
  guardianPhoneLabel: "Legal guardian phone",
  guardianConsentLabel: "As legal guardian, I confirm participation of the minor driver.",
  legalPageBackLabel: "Back to registration",
  summary: {
    title: "Legal notices and consents",
    introTitle: "Registration notice",
    introBody: [
      "By submitting the registration, MSC Oberlausitzer Dreiländereck e.V. processes the personal data you provide for event execution, participant management, communication related to your registration, preparation of event-related documents and the organizational and legal handling of participation.",
      "Personal data from the registration are generally stored until one year after the end of the event and are then deleted or anonymized unless statutory retention obligations or legal reasons require longer storage.",
      "The main legal bases are Art. 6(1)(b) GDPR for participation handling, Art. 6(1)(c) GDPR for legal obligations and Art. 6(1)(f) GDPR for the organizer's legitimate organizational interests. Where processing is not required for the event itself, it takes place only on the basis of a separate consent.",
      "Further information is available in the privacy notice."
    ],
    voluntaryTitle: "Voluntary consents",
    voluntaryBody:
      "Consent to photo and video recordings and to club information is voluntary and can be withdrawn at any time with effect for the future. Participation in the event does not depend on these optional consents.",
    waiverNoticeTitle: "Important waiver notice",
    waiverNoticeBody: "The waiver is part of the event documents. The binding signature is additionally provided on site during registration in writing.",
    linksTitle: "Legal documents",
    requiredTitle: "Required confirmations",
    optionalTitle: "Optional consents",
    termsAcceptanceLabel: "I have read and accept the participation terms.",
    privacyAcceptanceLabel: "I have taken note of the privacy notice.",
    waiverAcceptanceLabel: "I confirm that I have read the waiver and will sign it in binding form on site during registration.",
    mediaAcceptanceLabel:
      "I consent to photo and video recordings taken during the event, in which I can be recognized, being used for event reporting and for publication on the website and social media channels of MSC Oberlausitzer Dreiländereck e.V.",
    clubInfoAcceptanceLabel:
      "I consent to MSC Oberlausitzer Dreiländereck e.V. contacting me by email or phone about club information, future events and organizational notices.",
    minorNotice:
      "Minors may only be registered with the consent of a legal representative. The organizer may request corresponding proof or an additional signature."
  },
  docs: {
    impressum: imprintDocEn,
    datenschutz: privacyDocEn,
    teilnahmebedingungen: termsDocEn,
    haftverzicht: waiverDocEn
  }
};

const legalTextsCz: LegalTexts = {
  footerPrivacyLabel: "Ochrana udaju",
  footerImprintLabel: "Impressum",
  footerTermsLabel: "Podminky ucasti",
  footerWaiverLabel: "Vzdani se odpovednosti",
  guardianSectionTitle: "Udaje zakonneho zastupce (povinne pro jezdce do 18 let)",
  guardianFullNameLabel: "Cele jmeno zakonneho zastupce",
  guardianEmailLabel: "E-mail zakonneho zastupce",
  guardianPhoneLabel: "Telefon zakonneho zastupce",
  guardianConsentLabel: "Jako zakonny zastupce potvrzuji ucast nezletileho jezdce.",
  legalPageBackLabel: "Zpet k registraci",
  summary: {
    title: "Pravni informace a souhlasy",
    introTitle: "Informace k registraci",
    introBody: [
      "Odeslanim registrace zpracovava MSC Oberlausitzer Dreiländereck e.V. vami zadane osobni udaje pro provedeni akce, spravu ucastniku, komunikaci k registraci, pripravu dokumentu k akci a organizacni i pravni vyrizeni ucasti.",
      "Osobni udaje z registrace se zpravidla uchovavaji do jednoho roku po skonceni akce a pote se vymazou nebo anonymizuji, pokud delsi uchovani nevyplyva ze zakonne povinnosti nebo pravniho duvodu.",
      "Pravnimi zaklady jsou zejmena cl. 6 odst. 1 pism. b GDPR pro vyrizeni ucasti, cl. 6 odst. 1 pism. c GDPR pro zakonne povinnosti a cl. 6 odst. 1 pism. f GDPR pro opravneny organizacni zajem poradatele. Pokud zpracovani neni nutne pro samotnou akci, probiha pouze na zaklade samostatneho souhlasu.",
      "Dalsi informace naleznete v informacich o ochrane osobnich udaju."
    ],
    voluntaryTitle: "Dobrovolne souhlasy",
    voluntaryBody:
      "Souhlas s foto a video zaznamy i se zaslanim klubovych informaci je dobrovolny a lze jej kdykoli odvolat s ucinky do budoucna. Ucast na akci na techto volitelnych souhlasech nezavisi.",
    waiverNoticeTitle: "Dulezite upozorneni k prohlaseni o vzdani se odpovednosti",
    waiverNoticeBody: "Prohlaseni o vzdani se odpovednosti je soucasti dokumentace k akci. Zavazny podpis probiha navic osobne pri registraci na miste.",
    linksTitle: "Pravni texty",
    requiredTitle: "Povinna potvrzeni",
    optionalTitle: "Volitelne souhlasy",
    termsAcceptanceLabel: "Potvrzuji, ze jsem cetl(a) podminky ucasti a souhlasim s nimi.",
    privacyAcceptanceLabel: "Beru na vedomi informace o ochrane osobnich udaju.",
    waiverAcceptanceLabel: "Potvrzuji, ze jsem cetl(a) prohlaseni o vzdani se odpovednosti a ze jej zavazne podepisu pri registraci na miste.",
    mediaAcceptanceLabel:
      "Souhlasim s tim, aby foto a video zaznamy porizene behem akce, na nichz jsem rozpoznatelny(na), byly pouzity pro reportaz z akce a pro zverejneni na webu a socialnich sitich MSC Oberlausitzer Dreiländereck e.V.",
    clubInfoAcceptanceLabel:
      "Souhlasim s tim, aby me MSC Oberlausitzer Dreiländereck e.V. kontaktoval e-mailem nebo telefonicky ohledne klubovych informaci, budoucich akci a organizacnich oznameni.",
    minorNotice:
      "Nezletile osoby mohou byt registrovany pouze se souhlasem zakonneho zastupce. Poradatel muze vyzadovat odpovidajici potvrzeni nebo dalsi podpis."
  },
  docs: {
    impressum: imprintDocCz,
    datenschutz: privacyDocCz,
    teilnahmebedingungen: termsDocCz,
    haftverzicht: waiverDocCz
  }
};

const legalTextsPl: LegalTexts = {
  footerPrivacyLabel: "Prywatnosc",
  footerImprintLabel: "Impressum",
  footerTermsLabel: "Warunki udzialu",
  footerWaiverLabel: "Zrzeczenie odpowiedzialnosci",
  guardianSectionTitle: "Dane opiekuna prawnego (wymagane dla kierowcow ponizej 18 lat)",
  guardianFullNameLabel: "Pelne imie i nazwisko opiekuna prawnego",
  guardianEmailLabel: "E-mail opiekuna prawnego",
  guardianPhoneLabel: "Telefon opiekuna prawnego",
  guardianConsentLabel: "Jako opiekun prawny potwierdzam udzial niepelnoletniego kierowcy.",
  legalPageBackLabel: "Powrot do rejestracji",
  summary: {
    title: "Informacje prawne i zgody",
    introTitle: "Informacje o rejestracji",
    introBody: [
      "Po wyslaniu rejestracji MSC Oberlausitzer Dreiländereck e.V. przetwarza podane przez Ciebie dane osobowe w celu przeprowadzenia wydarzenia, zarzadzania uczestnikami, komunikacji dotyczacej zgloszenia, przygotowania dokumentow zwiazanych z wydarzeniem oraz organizacyjnej i prawnej obslugi uczestnictwa.",
      "Dane osobowe zgloszenia sa co do zasady przechowywane do jednego roku po zakonczeniu wydarzenia, a nastepnie usuwane lub anonimizowane, chyba ze dluzsze przechowywanie wynika z obowiazkow ustawowych lub przyczyn prawnych.",
      "Podstawami prawnymi sa w szczegolnosci art. 6 ust. 1 lit. b RODO dla obslugi uczestnictwa, art. 6 ust. 1 lit. c RODO dla obowiazkow prawnych oraz art. 6 ust. 1 lit. f RODO dla uzasadnionych interesow organizacyjnych organizatora. Jezeli przetwarzanie nie jest konieczne do realizacji wydarzenia, odbywa sie wylacznie na podstawie odrebnej zgody.",
      "Dalsze informacje znajduja sie w informacji o prywatnosci."
    ],
    voluntaryTitle: "Dobrowolne zgody",
    voluntaryBody:
      "Zgoda na zdjecia i nagrania wideo oraz na informacje klubowe jest dobrowolna i moze zostac w kazdym czasie odwolana ze skutkiem na przyszlosc. Udzial w wydarzeniu nie zalezy od tych opcjonalnych zgod.",
    waiverNoticeTitle: "Wazna informacja o zrzeczeniu odpowiedzialnosci",
    waiverNoticeBody: "Zrzeczenie odpowiedzialnosci jest czescia dokumentow wydarzenia. Wiazacy podpis skladany jest dodatkowo na miejscu podczas rejestracji w formie pisemnej.",
    linksTitle: "Teksty prawne",
    requiredTitle: "Wymagane potwierdzenia",
    optionalTitle: "Opcjonalne zgody",
    termsAcceptanceLabel: "Potwierdzam, ze zapoznalem(-am) sie z warunkami udzialu i akceptuje je.",
    privacyAcceptanceLabel: "Przyjalem(-am) do wiadomosci informacje o prywatnosci.",
    waiverAcceptanceLabel: "Potwierdzam, ze zapoznalem(-am) sie ze zrzeczeniem odpowiedzialnosci i podpisze je wiazaco na miejscu podczas rejestracji.",
    mediaAcceptanceLabel:
      "Wyrazam zgode na wykorzystanie zdjec i nagran wideo wykonanych podczas wydarzenia, na ktorych jestem rozpoznawalny(-a), do relacji z wydarzenia oraz publikacji na stronie internetowej i w mediach spolecznosciowych MSC Oberlausitzer Dreiländereck e.V.",
    clubInfoAcceptanceLabel:
      "Wyrazam zgode, aby MSC Oberlausitzer Dreiländereck e.V. kontaktowal sie ze mna telefonicznie lub mailowo w sprawie informacji klubowych, przyszlych wydarzen i komunikatow organizacyjnych.",
    minorNotice:
      "Osoby niepelnoletnie moga zostac zarejestrowane tylko za zgoda przedstawiciela ustawowego. Organizator moze zazadac odpowiedniego potwierdzenia lub dodatkowego podpisu."
  },
  docs: {
    impressum: imprintDocPl,
    datenschutz: privacyDocPl,
    teilnahmebedingungen: termsDocPl,
    haftverzicht: waiverDocPl
  }
};

const LEGAL_TEXTS: Record<LegalUiLocale, LegalTexts> = {
  de: legalTextsDe,
  en: legalTextsEn,
  cz: legalTextsCz,
  pl: legalTextsPl
};

export function getLegalTexts(locale: string): LegalTexts {
  if (locale === "en" || locale === "cz" || locale === "pl") {
    return LEGAL_TEXTS[locale];
  }
  return LEGAL_TEXTS.de;
}

export function getLegalDoc(locale: string, docId: string): LegalDoc {
  const texts = getLegalTexts(locale);
  if (docId === "haftung") {
    return texts.docs.haftverzicht;
  }
  if (docId === "agb") {
    return texts.docs.teilnahmebedingungen;
  }
  const key = docId as LegalDocId;
  return texts.docs[key] ?? texts.docs.datenschutz;
}

export function mapUiLocaleToConsentLocale(locale: string): ConsentLocale {
  if (locale === "en") {
    return "en-GB";
  }
  if (locale === "cz") {
    return "cs-CZ";
  }
  if (locale === "pl") {
    return "pl-PL";
  }
  return "de-DE";
}

export function buildConsentDisplayText(locale: string): string {
  const texts = getLegalTexts(locale);
  const docs = Object.values(texts.docs)
    .map((doc) => flattenDoc(doc))
    .join("\n\n");
  return normalizeForHash(
    [
      texts.summary.title,
      texts.summary.introTitle,
      ...texts.summary.introBody,
      texts.summary.waiverNoticeTitle,
      texts.summary.waiverNoticeBody,
      texts.summary.voluntaryTitle,
      texts.summary.voluntaryBody,
      texts.summary.requiredTitle,
      texts.summary.termsAcceptanceLabel,
      texts.summary.privacyAcceptanceLabel,
      texts.summary.waiverAcceptanceLabel,
      texts.summary.optionalTitle,
      texts.summary.mediaAcceptanceLabel,
      texts.summary.clubInfoAcceptanceLabel,
      texts.summary.minorNotice,
      docs
    ].join("\n")
  );
}

export async function computeConsentTextHash(locale: string): Promise<string> {
  const source = buildConsentDisplayText(locale);
  const payload = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
