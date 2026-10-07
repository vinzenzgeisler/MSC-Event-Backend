'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const outputPath = path.resolve('20-Fakten-Streckensprecher-2026.pdf');
const logoPath = path.resolve('infra/assets/stamp-cards/msc-logo-clean-transparent.png');
const regularFont = path.resolve('infra/assets/stamp-cards/fonts/barlow-500.ttf');
const boldFont = path.resolve('infra/assets/stamp-cards/fonts/barlow-700.ttf');

const facts = [
  ['231 Fahrer – 257 Nennungen', 'Alle sind zugelassen, technisch geprüft und haben den Haftverzicht unterschrieben.'],
  ['24 Mehrfachstarter', '22 Fahrer starten zweimal; zwei Fahrer gehen sogar dreimal an den Start.'],
  ['Dreifach im Einsatz', 'Nico Müller und William Klar sind mit jeweils drei Nennungen die fleißigsten Starter.'],
  ['Jüngster Fahrer: 18 Jahre', 'Filip Rejna · Startnr. 27 · Klasse 3 · Suzuki GP.'],
  ['Ältester Fahrer: 86 Jahre', 'Wolfgang Klix · Startnr. 358 · Klasse 9 · Formel Ford Royale RP24.'],
  ['68 Jahre Altersspanne', 'Zwischen dem jüngsten und dem ältesten Fahrer liegen fast sieben Jahrzehnte.'],
  ['Durchschnittsalter: 55,9 Jahre', 'Der Median liegt bei 58 Jahren – die Hälfte der Fahrer ist jünger, die andere älter.'],
  ['106 Fahrer sind mindestens 60', 'Das sind rund 46 Prozent; acht Fahrer sind jünger als 30 Jahre.'],
  ['Ältestes Fahrzeug: Baujahr 1923', 'Rico Vetter · Startnr. 3178 · Klasse 1 · Schüttoff – stolze 103 Jahre alt.'],
  ['Jüngstes Fahrzeug: Baujahr 2026', 'Tim Hartmann · Startnr. 44 · Klasse 8 · BMW S1000RR.'],
  ['103 Baujahre Vielfalt', 'Vom Jahrgang 1923 bis 2026; das mittlere Fahrzeugbaujahr ist 1983.'],
  ['Größter Hubraum: 5.561 cm³', 'Felix Hauswald · Startnr. 994 · Sonderlauf · Corvette C08.'],
  ['Zylinderrekord: acht Zylinder', 'Auch dieser Bestwert gehört Felix Hauswalds Corvette C08 im Sonderlauf.'],
  ['78 Prozent Motorräder', '200 Motorrad-Nennungen stehen 56 Automobil-Nennungen gegenüber.'],
  ['Honda führt das Markenfeld an', '30 Honda, 23 Suzuki, 22 Yamaha – dazu kommen 18 Trabant.'],
  ['95 Herstellerbezeichnungen', 'Vom historischen Einzelstück bis zum modernen Rennfahrzeug ist fast alles vertreten.'],
  ['Vier Nationen am Start', '216 Fahrer aus Deutschland, 9 aus Tschechien, 4 aus den Niederlanden und 1 aus Österreich.'],
  ['Weiteste Anreise: rund 624 km', 'Harry van Beek (Startnr. 31, Klasse 6) und Tom van Beek (Startnr. 1, Klasse 7).'],
  ['169 verschiedene Wohnorte', 'Am häufigsten vertreten: Dresden mit 14 und Berlin mit 10 Fahrern.'],
  ['Klasse 8 ist das größte Feld', '35 Nennungen; danach Klasse 6 mit 32 und Klasse 4 mit 30 Nennungen.']
];

const doc = new PDFDocument({
  size: 'A4',
  layout: 'landscape',
  margin: 0,
  info: {
    Title: '20 Fakten für den Streckensprecher – 12. Oberlausitzer Dreieck',
    Author: 'MSC Oberlausitzer Dreiländereck e. V.'
  }
});
const stream = fs.createWriteStream(outputPath);
doc.pipe(stream);
doc.registerFont('Regular', regularFont);
doc.registerFont('Bold', boldFont);

const pageWidth = doc.page.width;
const pageHeight = doc.page.height;
const margin = 30;
const gap = 16;
const columnWidth = (pageWidth - margin * 2 - gap) / 2;
const rowHeight = 42;
const rowGap = 3;

doc.rect(0, 0, pageWidth, 88).fill('#101820');
doc.image(logoPath, 30, 13, { fit: [62, 62] });
doc.font('Bold').fontSize(23).fillColor('#ffffff').text('20 FAKTEN FÜR DEN STRECKENSPRECHER', 108, 20, { width: 690, lineBreak: false });
doc.font('Regular').fontSize(11).fillColor('#d7dde2').text('12. Oberlausitzer Dreieck · Fahrer und Fahrzeuge 2026', 109, 52, { width: 660, lineBreak: false });
doc.rect(0, 82, pageWidth, 6).fill('#e3b341');

for (let index = 0; index < facts.length; index += 1) {
  const column = index < 10 ? 0 : 1;
  const row = index % 10;
  const x = margin + column * (columnWidth + gap);
  const y = 99 + row * (rowHeight + rowGap);
  const [headline, detail] = facts[index];

  doc.roundedRect(x, y, columnWidth, rowHeight, 4).fill(row % 2 === 0 ? '#f2f4f5' : '#ffffff');
  doc.circle(x + 16, y + rowHeight / 2, 10).fill('#e3b341');
  doc.font('Bold').fontSize(8.5).fillColor('#101820').text(String(index + 1), x + 10, y + 15.5, { width: 12, align: 'center', lineBreak: false });
  doc.font('Bold').fontSize(10.2).fillColor('#101820').text(headline, x + 34, y + 5, { width: columnWidth - 43, lineBreak: false, ellipsis: true });
  doc.font('Regular').fontSize(7.8).fillColor('#5b6670').text(detail, x + 34, y + 20, { width: columnWidth - 43, height: 18, lineGap: 0.5, ellipsis: true });
}

doc.font('Regular').fontSize(7.2).fillColor('#68737d').text(
  'Datenstand: 13.09.2026, ca. 07:00 Uhr · Grundlage: zugelassene Nennung, technische Prüfung bestanden und Haftverzicht des Fahrers unterschrieben. Namentliche Angaben nur für öffentlich nennbare Fahrer.',
  margin,
  pageHeight - 26,
  { width: pageWidth - margin * 2, align: 'center', lineBreak: false, ellipsis: true }
);

doc.end();
stream.on('finish', () => console.log(outputPath));
