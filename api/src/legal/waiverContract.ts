import { createHash } from 'node:crypto';

export const WAIVER_VERSION = 'OLD2026-HAFTVERZICHT-1.0.0' as const;
export const WAIVER_AUTHORITATIVE_LOCALE = 'de-DE' as const;

export type WaiverLocale = 'de-DE' | 'en-GB' | 'cs-CZ' | 'pl-PL';

export type WaiverSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type WaiverDocument = {
  id: 'haftverzicht';
  title: string;
  summaryLinkLabel: string;
  intro?: string[];
  sections: WaiverSection[];
};

const german: WaiverDocument = {
  id: 'haftverzicht',
  title: 'Vertrags- und Verzichtserklärung',
  summaryLinkLabel: 'Haftverzicht',
  intro: [
    'Die nachfolgende Vertrags- und Verzichtserklärung wird gegenüber dem MSC Oberlausitzer Dreiländereck e.V. als Veranstalter des 12. Oberlausitzer Dreiecks am 12. und 13. September 2026 abgegeben.',
    'Die Veranstaltung wird als Präsentationsfahrt historischer Motorsportfahrzeuge durchgeführt. Diese Erklärung gilt für die Teilnahme an der Veranstaltung einschließlich aller vorgesehenen Fahr- und Veranstaltungsabschnitte, die unmittelbar mit der Teilnahme und Durchführung der Veranstaltung zusammenhängen.',
    'Der vollständige Inhalt dieser Erklärung wird der unterzeichnenden Person vor Abgabe der digitalen Unterschrift angezeigt.'
  ],
  sections: [
    {
      title: '1. Vertragserklärung',
      paragraphs: ['Der Teilnehmer (Fahrer, Beifahrer) versichert, dass:'],
      bullets: [
        'die im Nennformular gemachten Angaben richtig und vollständig sind,',
        'Fahrer und gegebenenfalls Beifahrer den Anforderungen der Motorsportveranstaltung gesundheitlich gewachsen sind,',
        'das Fahrzeug den technischen Bestimmungen entspricht und der Teilnehmer für die technische Sicherheit selbst verantwortlich ist,',
        'das Fahrzeug in allen Teilen durch die Technischen Kommissare untersucht werden kann,',
        'das Fahrzeug nur in technisch und optisch einwandfreiem Zustand bei der Veranstaltung eingesetzt wird.'
      ]
    },
    {
      title: '',
      paragraphs: ['Der Teilnehmer (Fahrer, Beifahrer) erklärt mit seiner Unterschrift weiter, dass:'],
      bullets: [
        'er die Ausschreibungsbedingungen zur Kenntnis genommen hat, diese als für sich verbindlich anerkennt und befolgen wird,',
        'er im Besitz eines für das eingesetzte Fahrzeug erforderlichen gültigen Führerscheins ist,',
        'die für die Veranstaltung geltenden Regelungen und Bestimmungen sowie diese Erklärung mit seiner Zustimmung Bestandteil des Vertrages mit dem MSC Oberlausitzer Dreiländereck e.V. als Veranstalter werden,',
        'der Veranstalter im Rahmen seiner Zuständigkeit berechtigt ist, bei Verstößen Maßnahmen nach Maßgabe der Ausschreibung und der für die Veranstaltung geltenden Regelungen zu treffen,',
        'er sich verpflichtet, keine verbotenen Substanzen einzunehmen oder verbotene Methoden anzuwenden,',
        'das Einsatzfahrzeug sein Eigentum ist oder er zur Nutzung des Fahrzeugs berechtigt ist und, soweit erforderlich, eine entsprechende Erklärung des Fahrzeugeigentümers vorlegt,',
        'sogenannte „Burnouts“ auf dem Veranstaltungsgelände zu unterlassen sind; bei Schäden durch Nichteinhaltung wird der Verursacher im Rahmen der gesetzlichen Bestimmungen in Haftung genommen.'
      ]
    },
    {
      title: '2. Teilnahme auf eigene Gefahr',
      paragraphs: [
        'Der Teilnehmer (Fahrer, Beifahrer) nimmt auf eigene Gefahr an der Veranstaltung teil. Er trägt allein die zivil- und strafrechtliche Verantwortung für alle von ihm oder durch das von ihm benutzte Fahrzeug verursachten Schäden, soweit kein Haftungsausschluss vereinbart wurde.'
      ]
    },
    {
      title: '3. Haftungsverzicht gegenüber Veranstalter und weiteren Beteiligten',
      paragraphs: ['Der Teilnehmer (Fahrer, Beifahrer) erklärt mit Unterzeichnung dieser Erklärung den Verzicht auf Ansprüche jeder Art für Schäden, die im Zusammenhang mit der Veranstaltung entstehen, und zwar gegen:'],
      bullets: [
        'die FIA, die CIK, die FIM und die FIM Europe,',
        'den DMSB, dessen Mitgliedsorganisationen, die Deutsche Motor Sport Wirtschaftsdienst GmbH sowie deren Präsidenten, Organe, Geschäftsführer, Generalsekretäre, Vertreter und Funktionäre,',
        'den DMV sowie dessen Vertreter und Funktionäre,',
        'Promoter und Serienorganisatoren, soweit sie an der Veranstaltung beteiligt sind,',
        'den MSC Oberlausitzer Dreiländereck e.V. als Veranstalter,',
        'die Sportwarte,',
        'die Streckeneigentümer und Streckenbetreiber,',
        'Behörden, Renndienste und alle anderen Personen, die mit der Organisation oder Durchführung der Veranstaltung in Verbindung stehen,',
        'den Straßenbaulastträger, soweit Schäden durch die Beschaffenheit der bei der Veranstaltung zu benutzenden Straßen samt Zubehör verursacht werden,',
        'die Erfüllungs- und Verrichtungsgehilfen aller zuvor genannten Personen und Stellen.'
      ]
    },
    {
      title: '',
      paragraphs: ['Dieser Haftungsverzicht gilt nicht:'],
      bullets: [
        'für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit, die auf einer vorsätzlichen oder fahrlässigen Pflichtverletzung – auch eines gesetzlichen Vertreters oder eines Erfüllungsgehilfen des enthafteten Personenkreises – beruhen, und',
        'für sonstige Schäden, die auf einer vorsätzlichen oder grob fahrlässigen Pflichtverletzung – auch eines gesetzlichen Vertreters oder eines Erfüllungsgehilfen des enthafteten Personenkreises – beruhen.'
      ]
    },
    {
      title: '4. Haftungsverzicht gegenüber anderen Teilnehmern und eigenen Beteiligten',
      paragraphs: ['Gegen die folgenden Personen verzichtet der Teilnehmer auf Ansprüche jeder Art für Schäden, die im Zusammenhang mit der Veranstaltung entstehen:'],
      bullets: [
        'die anderen Teilnehmer (Bewerber, Fahrer, Beifahrer und gegebenenfalls Mitfahrer) und deren Helfer,',
        'die Eigentümer und Halter der anderen Fahrzeuge,',
        'den eigenen Bewerber, die eigenen Fahrer, Beifahrer und gegebenenfalls Mitfahrer sowie die eigenen Helfer.'
      ]
    },
    {
      title: '',
      paragraphs: [
        'Anderslautende besondere Vereinbarungen zwischen Bewerber, Fahrer, Beifahrer oder Mitfahrer gehen vor.',
        'Auch dieser Haftungsverzicht gilt nicht:'
      ],
      bullets: [
        'für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit, die auf einer vorsätzlichen oder fahrlässigen Pflichtverletzung – auch eines gesetzlichen Vertreters oder eines Erfüllungsgehilfen des enthafteten Personenkreises – beruhen, und',
        'für sonstige Schäden, die auf einer vorsätzlichen oder grob fahrlässigen Pflichtverletzung – auch eines gesetzlichen Vertreters oder eines Erfüllungsgehilfen des enthafteten Personenkreises – beruhen.'
      ]
    },
    {
      title: '5. Wirksamkeit und Umfang',
      paragraphs: [
        'Der Haftungsausschluss wird mit Unterzeichnung dieser Erklärung allen Beteiligten gegenüber wirksam.',
        'Der Haftungsverzicht gilt für Ansprüche aus jeglichem Rechtsgrund, insbesondere sowohl für Schadensersatzansprüche aus vertraglicher als auch aus außervertraglicher Haftung sowie für Ansprüche aus unerlaubter Handlung.',
        'Stillschweigende Haftungsausschlüsse bleiben von den vorstehenden Haftungsausschlussklauseln unberührt.'
      ]
    },
    {
      title: '6. Versicherungsschutz',
      paragraphs: [
        'Soweit gesetzlicher oder vertraglicher Haftpflichtversicherungsschutz besteht, wird dieser durch diese Vertrags- und Verzichtserklärung nicht berührt. Rechte und Ansprüche gegenüber Versicherern bestimmen sich nach den jeweils geltenden gesetzlichen Vorschriften und Versicherungsbedingungen.'
      ]
    },
    {
      title: '7. Absage aufgrund höherer Gewalt',
      paragraphs: [
        'Muss die Veranstaltung aufgrund höherer Gewalt, insbesondere aufgrund von Unwetter, behördlichen Anordnungen, Fahrverboten oder vergleichbaren, vom Veranstalter nicht zu vertretenden Umständen abgesagt werden, verzichtet der Teilnehmer auf die Rückerstattung des Nenngeldes.'
      ]
    },
    {
      title: '8. Minderjährige Teilnehmer',
      paragraphs: ['Ist der Teilnehmer minderjährig, erklären der bzw. die gesetzlichen Vertreter:'],
      bullets: [
        'dass sie der Teilnahme des minderjährigen Teilnehmers an der Veranstaltung zustimmen,',
        'dass sie die vorstehende Vertrags- und Verzichtserklärung im Namen des minderjährigen Teilnehmers abgeben und den darin enthaltenen Regelungen und Haftungsverzichten für ihn zustimmen,',
        'dass sie die Erklärung zugleich im eigenen Namen abgeben,',
        'dass sie zur gesetzlichen Vertretung des minderjährigen Teilnehmers und zur Abgabe dieser Erklärung berechtigt sind.'
      ]
    },
    {
      title: '',
      paragraphs: [
        'Der bzw. die gesetzlichen Vertreter verzichten, soweit gesetzlich zulässig, im eigenen Namen auf Ansprüche jeder Art für Schäden, die ihnen im Zusammenhang mit der Teilnahme des minderjährigen Teilnehmers an der Veranstaltung entstehen, insbesondere auf eigene Ansprüche wegen einer Verletzung oder Schädigung des minderjährigen Teilnehmers, gegenüber den in den Ziffern 3 und 4 genannten Personen und Stellen.',
        'Für diesen eigenen Haftungsverzicht der gesetzlichen Vertreter gelten die Haftungsausnahmen der Ziffern 3 und 4 entsprechend. Der Haftungsverzicht gilt insbesondere nicht:'
      ],
      bullets: [
        'für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit, die auf einer vorsätzlichen oder fahrlässigen Pflichtverletzung beruhen, und',
        'für sonstige Schäden, die auf einer vorsätzlichen oder grob fahrlässigen Pflichtverletzung beruhen.'
      ]
    },
    {
      title: '',
      paragraphs: [
        'Sind mehrere gesetzliche Vertreter nur gemeinschaftlich zur Vertretung berechtigt, ist die Erklärung von allen für die Vertretung erforderlichen gesetzlichen Vertretern abzugeben.',
        'Eine zusätzliche Unterschrift des minderjährigen Teilnehmers kann zur Dokumentation seiner Kenntnisnahme erfolgen, ersetzt jedoch nicht die erforderliche Erklärung des bzw. der gesetzlichen Vertreter.'
      ]
    },
    {
      title: '9. Abschließende Bestätigung und digitale Unterzeichnung',
      paragraphs: [
        'Die unterzeichnende Person bestätigt, dass ihr die vorstehende Vertrags- und Verzichtserklärung vor Abgabe der digitalen Unterschrift vollständig angezeigt wurde und ausreichend Gelegenheit bestand, deren Inhalt zur Kenntnis zu nehmen.',
        'Die Identität und persönliche Anwesenheit der unterzeichnenden Person werden vor der Unterzeichnung durch einen Mitarbeiter des Veranstalters geprüft.',
        'Mit der digitalen handschriftlichen Unterschrift auf dem vom Veranstalter bereitgestellten Endgerät wird die vorstehende Vertrags- und Verzichtserklärung verbindlich abgegeben.',
        'Bei minderjährigen Teilnehmern gilt dies für jede erforderliche Erklärung des bzw. der gesetzlichen Vertreter.',
        'Die Unterzeichnung wird zusammen mit der verwendeten Dokumentversion, dem zugrunde liegenden Rechtstext, dem Unterzeichnungszeitpunkt, der Signatur und einem Audit-Nachweis dokumentiert.'
      ]
    }
  ]
};

const english: WaiverDocument = {
  id: 'haftverzicht',
  title: 'Contractual Declaration and Waiver of Liability',
  summaryLinkLabel: 'Waiver of liability',
  intro: [
    'The following contractual declaration and waiver of liability is made to MSC Oberlausitzer Dreiländereck e.V. as organiser of the 12th Oberlausitzer Dreieck on 12 and 13 September 2026.',
    'The event is held as a presentation run for historic motorsport vehicles. This declaration applies to participation in the event, including all intended driving and event sections directly connected with participation in and conduct of the event.',
    'The full content of this declaration will be shown to the signing person before the digital signature is provided.'
  ],
  sections: [
    { title: '1. Contractual declaration', paragraphs: ['The participant (driver, co-driver) warrants that:'], bullets: ['the information provided on the entry form is correct and complete,', 'the driver and, where applicable, the co-driver are physically fit for the demands of the motorsport event,', 'the vehicle complies with the technical regulations and the participant is personally responsible for its technical safety,', 'all parts of the vehicle may be inspected by the technical scrutineers,', 'the vehicle will be used at the event only in a technically and visually faultless condition.'] },
    { title: '1. Contractual declaration – continued', paragraphs: ['By signing, the participant (driver, co-driver) further declares that:'], bullets: ['they have taken note of the supplementary regulations, accept them as binding and will comply with them,', 'they hold a valid driving licence required for the vehicle used,', 'the rules and regulations applicable to the event and this declaration become part of the contract with MSC Oberlausitzer Dreiländereck e.V. as organiser with their consent,', 'within its area of responsibility, the organiser is entitled to take measures in the event of infringements in accordance with the supplementary regulations and the rules applicable to the event,', 'they undertake not to take prohibited substances or use prohibited methods,', 'the competition vehicle is their property or they are authorised to use it and, where required, will submit a corresponding declaration from the vehicle owner,', 'so-called burnouts are prohibited on the event grounds; any person causing damage by failing to comply will be held liable in accordance with statutory provisions.'] },
    { title: '2. Participation at own risk', paragraphs: ['The participant (driver, co-driver) takes part in the event at their own risk. They bear sole civil and criminal responsibility for all damage caused by them or by the vehicle used by them, unless an exclusion of liability has been agreed.'] },
    { title: '3. Waiver in favour of the organiser and other parties', paragraphs: ['By signing this declaration, the participant waives claims of any kind for damage arising in connection with the event against:'], bullets: ['the FIA, CIK, FIM and FIM Europe,', 'the DMSB, its member organisations, Deutsche Motor Sport Wirtschaftsdienst GmbH and their presidents, governing bodies, managing directors, secretaries general, representatives and officials,', 'the DMV and its representatives and officials,', 'promoters and series organisers insofar as they are involved in the event,', 'MSC Oberlausitzer Dreiländereck e.V. as organiser,', 'the officials,', 'the track owners and track operators,', 'authorities, race services and all other persons connected with the organisation or conduct of the event,', 'the public road authority insofar as damage is caused by the condition of the roads and their accessories used for the event,', 'the agents and servants of all persons and bodies named above.'] },
    { title: '3. Waiver – exceptions', paragraphs: ['This waiver does not apply:'], bullets: ['to damage resulting from injury to life, limb or health caused by an intentional or negligent breach of duty, including by a legal representative or agent of a released party, and', 'to other damage caused by an intentional or grossly negligent breach of duty, including by a legal representative or agent of a released party.'] },
    { title: '4. Waiver in favour of other participants and own parties', paragraphs: ['The participant waives claims of any kind for damage arising in connection with the event against:'], bullets: ['the other participants (entrants, drivers, co-drivers and, where applicable, passengers) and their assistants,', 'the owners and registered keepers of the other vehicles,', 'their own entrant, drivers, co-drivers and, where applicable, passengers and assistants.'] },
    { title: '4. Waiver – special agreements and exceptions', paragraphs: ['Any special agreements to the contrary between entrant, driver, co-driver or passenger take precedence.', 'This waiver likewise does not apply:'], bullets: ['to damage resulting from injury to life, limb or health caused by an intentional or negligent breach of duty, including by a legal representative or agent of a released party, and', 'to other damage caused by an intentional or grossly negligent breach of duty, including by a legal representative or agent of a released party.'] },
    { title: '5. Effect and scope', paragraphs: ['The exclusion of liability takes effect in relation to all parties when this declaration is signed.', 'The waiver applies to claims on any legal basis, in particular contractual and non-contractual damages claims and claims in tort.', 'Implied exclusions of liability remain unaffected by the provisions above.'] },
    { title: '6. Insurance cover', paragraphs: ['Where statutory or contractual liability insurance cover exists, it is not affected by this contractual declaration and waiver. Rights and claims against insurers are governed by the applicable statutory provisions and insurance terms.'] },
    { title: '7. Cancellation due to force majeure', paragraphs: ['If the event must be cancelled due to force majeure, in particular severe weather, official orders, driving bans or comparable circumstances beyond the organiser’s control, the participant waives reimbursement of the entry fee.'] },
    { title: '8. Minor participants', paragraphs: ['If the participant is a minor, the legal representative or representatives declare:'], bullets: ['that they consent to the minor’s participation in the event,', 'that they make this contractual declaration and waiver in the name of the minor and consent to its rules and waivers on the minor’s behalf,', 'that they also make the declaration in their own name,', 'that they are authorised to represent the minor legally and to make this declaration.'] },
    { title: '8. Minor participants – representatives’ own waiver', paragraphs: ['To the extent permitted by law, the legal representative or representatives waive in their own name claims of any kind arising for them in connection with the minor’s participation, in particular their own claims arising from injury or damage to the minor, against the persons and bodies listed in sections 3 and 4.', 'The exceptions in sections 3 and 4 apply correspondingly to this personal waiver. In particular, the waiver does not apply:'], bullets: ['to damage resulting from injury to life, limb or health caused by an intentional or negligent breach of duty, and', 'to other damage caused by an intentional or grossly negligent breach of duty.'] },
    { title: '8. Minor participants – representation', paragraphs: ['If several legal representatives are authorised to act only jointly, the declaration must be made by all legal representatives required for representation.', 'An additional signature by the minor may document their acknowledgement but does not replace the required declaration by the legal representative or representatives.'] },
    { title: '9. Final confirmation and digital signature', paragraphs: ['The signing person confirms that the complete contractual declaration and waiver above was displayed before the digital signature and that sufficient opportunity was given to read it.', 'The signing person’s identity and physical presence are checked by an organiser’s employee before signature.', 'The handwritten digital signature on the device supplied by the organiser makes this contractual declaration and waiver binding.', 'For minor participants, this applies to every required declaration by the legal representative or representatives.', 'The signature is documented together with the document version used, the underlying legal text, the time of signature, the signature itself and an audit record.'] }
  ]
};

const czech: WaiverDocument = {
  id: 'haftverzicht', title: 'Smluvní prohlášení a vzdání se nároků', summaryLinkLabel: 'Vzdání se odpovědnosti',
  intro: ['Následující smluvní prohlášení a vzdání se nároků se činí vůči MSC Oberlausitzer Dreiländereck e.V. jako pořadateli 12. ročníku Oberlausitzer Dreieck ve dnech 12. a 13. září 2026.', 'Akce se koná jako prezentační jízda historických motoristických vozidel. Toto prohlášení platí pro účast na akci včetně všech plánovaných jízdních a organizačních částí, které přímo souvisejí s účastí a konáním akce.', 'Úplný obsah tohoto prohlášení bude podepisující osobě zobrazen před odevzdáním digitálního podpisu.'],
  sections: [
    { title: '1. Smluvní prohlášení', paragraphs: ['Účastník (jezdec, spolujezdec) ujišťuje, že:'], bullets: ['údaje uvedené v přihlášce jsou správné a úplné,', 'jezdec a případně spolujezdec jsou zdravotně způsobilí zvládnout požadavky motoristické akce,', 'vozidlo odpovídá technickým předpisům a účastník sám odpovídá za jeho technickou bezpečnost,', 'technickým komisařům může být umožněna kontrola všech částí vozidla,', 'vozidlo bude při akci použito pouze v technicky a vzhledově bezvadném stavu.'] },
    { title: '1. Smluvní prohlášení – pokračování', paragraphs: ['Účastník (jezdec, spolujezdec) svým podpisem dále prohlašuje, že:'], bullets: ['se seznámil s propozicemi, uznává je za závazné a bude je dodržovat,', 'je držitelem platného řidičského oprávnění požadovaného pro použité vozidlo,', 'pravidla a předpisy platné pro akci a toto prohlášení se s jeho souhlasem stávají součástí smlouvy s MSC Oberlausitzer Dreiländereck e.V. jako pořadatelem,', 'pořadatel je v rámci své působnosti oprávněn při porušení přijmout opatření podle propozic a pravidel platných pro akci,', 'se zavazuje neužívat zakázané látky ani zakázané metody,', 'soutěžní vozidlo je jeho vlastnictvím nebo je oprávněn je používat a v případě potřeby předloží odpovídající prohlášení vlastníka,', 'takzvané burnouty jsou v areálu akce zakázány; původce škody způsobené nedodržením bude odpovídat podle právních předpisů.'] },
    { title: '2. Účast na vlastní nebezpečí', paragraphs: ['Účastník (jezdec, spolujezdec) se akce účastní na vlastní nebezpečí. Nese výlučnou občanskoprávní a trestní odpovědnost za všechny škody způsobené jím nebo jím používaným vozidlem, pokud nebylo sjednáno vyloučení odpovědnosti.'] },
    { title: '3. Vzdání se nároků vůči pořadateli a dalším osobám', paragraphs: ['Účastník se podpisem vzdává nároků všeho druhu za škody související s akcí vůči:'], bullets: ['FIA, CIK, FIM a FIM Europe,', 'DMSB, jeho členským organizacím, Deutsche Motor Sport Wirtschaftsdienst GmbH a jejich prezidentům, orgánům, jednatelům, generálním sekretářům, zástupcům a funkcionářům,', 'DMV a jeho zástupcům a funkcionářům,', 'promotérům a organizátorům seriálů, pokud se na akci podílejí,', 'MSC Oberlausitzer Dreiländereck e.V. jako pořadateli,', 'sportovním komisařům a činovníkům,', 'vlastníkům a provozovatelům tratě,', 'úřadům, závodním službám a všem dalším osobám spojeným s organizací nebo konáním akce,', 'správci komunikace, pokud škoda vznikla stavem silnic a jejich příslušenství používaných při akci,', 'pomocníkům a osobám plnícím úkoly všech výše uvedených osob a subjektů.'] },
    { title: '3. Výjimky', paragraphs: ['Toto vzdání se nároků se nevztahuje:'], bullets: ['na újmu na životě, těle nebo zdraví způsobenou úmyslným nebo nedbalostním porušením povinnosti, včetně porušení zákonným zástupcem nebo pomocníkem osoby zproštěné odpovědnosti, a', 'na jiné škody způsobené úmyslným nebo hrubě nedbalostním porušením povinnosti, včetně porušení zákonným zástupcem nebo pomocníkem osoby zproštěné odpovědnosti.'] },
    { title: '4. Vzdání se nároků vůči ostatním účastníkům a vlastním osobám', paragraphs: ['Účastník se vzdává nároků všeho druhu za škody související s akcí vůči:'], bullets: ['ostatním účastníkům (přihlašovatelům, jezdcům, spolujezdcům a případně pasažérům) a jejich pomocníkům,', 'vlastníkům a provozovatelům ostatních vozidel,', 'vlastnímu přihlašovateli, vlastním jezdcům, spolujezdcům, případně pasažérům a pomocníkům.'] },
    { title: '4. Zvláštní dohody a výjimky', paragraphs: ['Odlišná zvláštní ujednání mezi přihlašovatelem, jezdcem, spolujezdcem nebo pasažérem mají přednost.', 'Ani toto vzdání se nároků se nevztahuje:'], bullets: ['na újmu na životě, těle nebo zdraví způsobenou úmyslným nebo nedbalostním porušením povinnosti, a', 'na jiné škody způsobené úmyslným nebo hrubě nedbalostním porušením povinnosti.'] },
    { title: '5. Účinnost a rozsah', paragraphs: ['Vyloučení odpovědnosti nabývá podpisem tohoto prohlášení účinnosti vůči všem zúčastněným.', 'Vzdání se nároků platí pro nároky z jakéhokoli právního důvodu, zejména pro smluvní i mimosmluvní nároky na náhradu škody a nároky z protiprávního jednání.', 'Konkludentní vyloučení odpovědnosti zůstávají nedotčena.'] },
    { title: '6. Pojistná ochrana', paragraphs: ['Existující zákonné nebo smluvní pojištění odpovědnosti není tímto prohlášením dotčeno. Práva a nároky vůči pojistitelům se řídí platnými právními předpisy a pojistnými podmínkami.'] },
    { title: '7. Zrušení z důvodu vyšší moci', paragraphs: ['Musí-li být akce zrušena z důvodu vyšší moci, zejména nepříznivého počasí, úředních nařízení, zákazů jízdy nebo srovnatelných okolností, které pořadatel nezavinil, účastník se vzdává vrácení startovného.'] },
    { title: '8. Nezletilí účastníci', paragraphs: ['Je-li účastník nezletilý, zákonný zástupce či zástupci prohlašují:'], bullets: ['že souhlasí s účastí nezletilého na akci,', 'že toto prohlášení činí jménem nezletilého a souhlasí za něj s obsaženými pravidly a vzdáním se nároků,', 'že prohlášení činí rovněž vlastním jménem,', 'že jsou oprávněni nezletilého zastupovat a toto prohlášení učinit.'] },
    { title: '8. Vlastní vzdání se nároků zákonných zástupců', paragraphs: ['Zákonný zástupce či zástupci se v rozsahu dovoleném zákonem vlastním jménem vzdávají nároků vzniklých v souvislosti s účastí nezletilého, zejména vlastních nároků z jeho zranění nebo poškození, vůči osobám a subjektům uvedeným v bodech 3 a 4.', 'Výjimky podle bodů 3 a 4 platí obdobně. Vzdání se nároků se zejména nevztahuje:'], bullets: ['na újmu na životě, těle nebo zdraví způsobenou úmyslným nebo nedbalostním porušením povinnosti, a', 'na jiné škody způsobené úmyslným nebo hrubě nedbalostním porušením povinnosti.'] },
    { title: '8. Zastupování', paragraphs: ['Jsou-li zákonní zástupci oprávněni jednat pouze společně, musí prohlášení učinit všichni zástupci potřební k zastoupení.', 'Dodatečný podpis nezletilého může doložit jeho seznámení, nenahrazuje však prohlášení zákonného zástupce či zástupců.'] },
    { title: '9. Závěrečné potvrzení a digitální podpis', paragraphs: ['Podepisující osoba potvrzuje, že jí bylo před digitálním podpisem zobrazeno celé výše uvedené prohlášení a měla dostatek příležitostí se s ním seznámit.', 'Totožnost a osobní přítomnost podepisující osoby před podpisem ověří pracovník pořadatele.', 'Digitálním vlastnoručním podpisem na zařízení poskytnutém pořadatelem je toto prohlášení závazně učiněno.', 'U nezletilých to platí pro každé potřebné prohlášení zákonného zástupce či zástupců.', 'Podpis se dokumentuje spolu s verzí dokumentu, podkladovým právním textem, časem podpisu, podpisem a auditním záznamem.'] }
  ]
};

const polish: WaiverDocument = {
  id: 'haftverzicht', title: 'Oświadczenie umowne i zrzeczenie się roszczeń', summaryLinkLabel: 'Zrzeczenie odpowiedzialności',
  intro: ['Niniejsze oświadczenie umowne i zrzeczenie się roszczeń jest składane wobec MSC Oberlausitzer Dreiländereck e.V. jako organizatora 12. Oberlausitzer Dreieck w dniach 12 i 13 września 2026 r.', 'Impreza jest organizowana jako przejazd prezentacyjny historycznych pojazdów sportów motorowych. Oświadczenie obejmuje udział w imprezie wraz ze wszystkimi przewidzianymi odcinkami jazdy i częściami wydarzenia bezpośrednio związanymi z udziałem i przeprowadzeniem imprezy.', 'Pełna treść oświadczenia zostanie wyświetlona osobie podpisującej przed złożeniem podpisu cyfrowego.'],
  sections: [
    { title: '1. Oświadczenie umowne', paragraphs: ['Uczestnik (kierowca, pilot) zapewnia, że:'], bullets: ['dane podane w formularzu zgłoszeniowym są prawidłowe i kompletne,', 'kierowca i ewentualny pilot są zdrowotnie zdolni sprostać wymaganiom imprezy motorowej,', 'pojazd spełnia wymagania techniczne, a uczestnik sam odpowiada za jego bezpieczeństwo techniczne,', 'wszystkie części pojazdu mogą zostać zbadane przez komisarzy technicznych,', 'pojazd będzie używany podczas imprezy wyłącznie w nienagannym stanie technicznym i wizualnym.'] },
    { title: '1. Oświadczenie umowne – ciąg dalszy', paragraphs: ['Podpisując, uczestnik (kierowca, pilot) oświadcza ponadto, że:'], bullets: ['zapoznał się z regulaminem uzupełniającym, uznaje go za wiążący i będzie go przestrzegać,', 'posiada ważne prawo jazdy wymagane dla używanego pojazdu,', 'zasady i przepisy obowiązujące podczas imprezy oraz niniejsze oświadczenie stają się za jego zgodą częścią umowy z MSC Oberlausitzer Dreiländereck e.V. jako organizatorem,', 'organizator jest uprawniony w swoim zakresie odpowiedzialności do podejmowania działań w przypadku naruszeń zgodnie z regulaminem i zasadami imprezy,', 'zobowiązuje się nie przyjmować zabronionych substancji ani nie stosować zabronionych metod,', 'pojazd startowy jest jego własnością lub jest uprawniony do jego używania i w razie potrzeby przedłoży odpowiednie oświadczenie właściciela,', 'tak zwane burnouty są zabronione na terenie imprezy; sprawca szkody wynikłej z naruszenia zakazu odpowiada zgodnie z przepisami prawa.'] },
    { title: '2. Udział na własne ryzyko', paragraphs: ['Uczestnik (kierowca, pilot) bierze udział w imprezie na własne ryzyko. Ponosi wyłączną odpowiedzialność cywilną i karną za wszystkie szkody spowodowane przez siebie lub używany pojazd, o ile nie uzgodniono wyłączenia odpowiedzialności.'] },
    { title: '3. Zrzeczenie wobec organizatora i innych podmiotów', paragraphs: ['Podpisując oświadczenie, uczestnik zrzeka się wszelkich roszczeń za szkody związane z imprezą wobec:'], bullets: ['FIA, CIK, FIM i FIM Europe,', 'DMSB, jego organizacji członkowskich, Deutsche Motor Sport Wirtschaftsdienst GmbH oraz ich prezydentów, organów, dyrektorów, sekretarzy generalnych, przedstawicieli i funkcjonariuszy,', 'DMV oraz jego przedstawicieli i funkcjonariuszy,', 'promotorów i organizatorów serii, o ile uczestniczą w imprezie,', 'MSC Oberlausitzer Dreiländereck e.V. jako organizatora,', 'sędziów i osób funkcyjnych,', 'właścicieli i operatorów trasy,', 'organów administracji, służb wyścigowych i wszystkich innych osób związanych z organizacją lub przeprowadzeniem imprezy,', 'zarządcy drogi, o ile szkoda została spowodowana stanem dróg i ich wyposażenia używanych podczas imprezy,', 'osób wykonujących zobowiązania i pomocników wszystkich wyżej wymienionych osób i podmiotów.'] },
    { title: '3. Wyjątki', paragraphs: ['Zrzeczenie nie obowiązuje:'], bullets: ['w przypadku szkód wynikających z naruszenia życia, ciała lub zdrowia wskutek umyślnego albo niedbałego naruszenia obowiązków, również przez przedstawiciela ustawowego lub pomocnika zwolnionego podmiotu, oraz', 'w przypadku innych szkód wynikających z umyślnego albo rażąco niedbałego naruszenia obowiązków, również przez przedstawiciela ustawowego lub pomocnika zwolnionego podmiotu.'] },
    { title: '4. Zrzeczenie wobec innych uczestników i własnych osób', paragraphs: ['Uczestnik zrzeka się wszelkich roszczeń za szkody związane z imprezą wobec:'], bullets: ['innych uczestników (zgłaszających, kierowców, pilotów i ewentualnych pasażerów) oraz ich pomocników,', 'właścicieli i posiadaczy innych pojazdów,', 'własnego zgłaszającego, własnych kierowców, pilotów, ewentualnych pasażerów i pomocników.'] },
    { title: '4. Szczególne ustalenia i wyjątki', paragraphs: ['Odmienne szczególne ustalenia między zgłaszającym, kierowcą, pilotem lub pasażerem mają pierwszeństwo.', 'Również to zrzeczenie nie obowiązuje:'], bullets: ['w przypadku szkód na życiu, ciele lub zdrowiu wynikających z umyślnego albo niedbałego naruszenia obowiązków, oraz', 'w przypadku innych szkód wynikających z umyślnego albo rażąco niedbałego naruszenia obowiązków.'] },
    { title: '5. Skuteczność i zakres', paragraphs: ['Wyłączenie odpowiedzialności staje się skuteczne wobec wszystkich zainteresowanych z chwilą podpisania oświadczenia.', 'Zrzeczenie dotyczy roszczeń z każdego tytułu prawnego, w szczególności umownych i pozaumownych roszczeń odszkodowawczych oraz roszczeń z czynu niedozwolonego.', 'Dorozumiane wyłączenia odpowiedzialności pozostają nienaruszone.'] },
    { title: '6. Ochrona ubezpieczeniowa', paragraphs: ['Niniejsze oświadczenie nie narusza istniejącej ustawowej lub umownej ochrony ubezpieczeniowej odpowiedzialności cywilnej. Prawa i roszczenia wobec ubezpieczycieli określają właściwe przepisy i warunki ubezpieczenia.'] },
    { title: '7. Odwołanie z powodu siły wyższej', paragraphs: ['Jeżeli impreza musi zostać odwołana z powodu siły wyższej, w szczególności niepogody, nakazów urzędowych, zakazów jazdy lub podobnych okoliczności niezależnych od organizatora, uczestnik zrzeka się zwrotu wpisowego.'] },
    { title: '8. Uczestnicy małoletni', paragraphs: ['Jeżeli uczestnik jest małoletni, przedstawiciel lub przedstawiciele ustawowi oświadczają:'], bullets: ['że wyrażają zgodę na udział małoletniego w imprezie,', 'że składają niniejsze oświadczenie w imieniu małoletniego i wyrażają w jego imieniu zgodę na zawarte zasady i zrzeczenia,', 'że składają oświadczenie również we własnym imieniu,', 'że są uprawnieni do ustawowej reprezentacji małoletniego i złożenia oświadczenia.'] },
    { title: '8. Własne zrzeczenie przedstawicieli', paragraphs: ['W zakresie dozwolonym prawem przedstawiciel lub przedstawiciele ustawowi zrzekają się we własnym imieniu wszelkich roszczeń powstałych w związku z udziałem małoletniego, w szczególności własnych roszczeń z tytułu jego obrażeń lub szkody, wobec osób i podmiotów wymienionych w punktach 3 i 4.', 'Wyjątki z punktów 3 i 4 stosuje się odpowiednio. Zrzeczenie w szczególności nie obowiązuje:'], bullets: ['w przypadku szkód na życiu, ciele lub zdrowiu wynikających z umyślnego albo niedbałego naruszenia obowiązków, oraz', 'w przypadku innych szkód wynikających z umyślnego albo rażąco niedbałego naruszenia obowiązków.'] },
    { title: '8. Reprezentacja', paragraphs: ['Jeżeli kilku przedstawicieli ustawowych może działać wyłącznie wspólnie, oświadczenie muszą złożyć wszyscy przedstawiciele wymagani do reprezentacji.', 'Dodatkowy podpis małoletniego może dokumentować zapoznanie się z treścią, ale nie zastępuje oświadczenia przedstawiciela lub przedstawicieli ustawowych.'] },
    { title: '9. Potwierdzenie końcowe i podpis cyfrowy', paragraphs: ['Osoba podpisująca potwierdza, że przed złożeniem podpisu cyfrowego wyświetlono jej pełną treść powyższego oświadczenia i zapewniono wystarczającą możliwość zapoznania się z nią.', 'Tożsamość i osobista obecność osoby podpisującej są sprawdzane przed podpisem przez pracownika organizatora.', 'Cyfrowy podpis odręczny na urządzeniu udostępnionym przez organizatora powoduje wiążące złożenie oświadczenia.', 'W przypadku małoletnich dotyczy to każdego wymaganego oświadczenia przedstawiciela lub przedstawicieli ustawowych.', 'Podpis jest dokumentowany wraz z używaną wersją dokumentu, tekstem prawnym, czasem podpisu, podpisem i zapisem audytowym.'] }
  ]
};

const documents: Record<WaiverLocale, WaiverDocument> = {
  'de-DE': german,
  'en-GB': english,
  'cs-CZ': czech,
  'pl-PL': polish
};

export const flattenWaiverDocument = (doc: WaiverDocument): string => [
  doc.title,
  ...(doc.intro ?? []),
  ...doc.sections.flatMap((section) => [
    ...(section.title ? [section.title] : []),
    ...(section.paragraphs ?? []),
    ...(section.bullets ?? []).map((bullet) => `• ${bullet}`)
  ])
].join('\n\n').normalize('NFC').replace(/\r/g, '').trim();

export const waiverTextHash = (doc: WaiverDocument): string =>
  createHash('sha256').update(flattenWaiverDocument(doc), 'utf8').digest('hex');

export const getWaiverDocument = (locale: WaiverLocale): WaiverDocument => documents[locale];

export const buildWaiverContract = (locale: WaiverLocale) => {
  const authoritative = getWaiverDocument(WAIVER_AUTHORITATIVE_LOCALE);
  const translated = locale === WAIVER_AUTHORITATIVE_LOCALE ? null : getWaiverDocument(locale);
  const fullText = flattenWaiverDocument(authoritative);
  return {
    documentId: 'haftverzicht' as const,
    locale,
    version: WAIVER_VERSION,
    title: authoritative.title,
    fullText,
    textHash: waiverTextHash(authoritative),
    authoritativeLocale: WAIVER_AUTHORITATIVE_LOCALE,
    authoritativeTitle: authoritative.title,
    authoritativeFullText: fullText,
    authoritativeTextHash: waiverTextHash(authoritative),
    translation: translated ? {
      locale,
      title: translated.title,
      fullText: flattenWaiverDocument(translated),
      textHash: waiverTextHash(translated),
      binding: false as const
    } : null,
    source: 'backend_contract_context' as const
  };
};

export const WAIVER_TEXT_HASHES: Record<WaiverLocale, string> = {
  'de-DE': waiverTextHash(german),
  'en-GB': waiverTextHash(english),
  'cs-CZ': waiverTextHash(czech),
  'pl-PL': waiverTextHash(polish)
};
