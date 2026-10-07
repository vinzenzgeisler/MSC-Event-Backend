'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const outputPath = path.resolve('Schlussbericht-Teilnehmer-Fahrzeuge-2026.pdf');
const regularFont = path.resolve('infra/assets/mail-fonts/arial.ttf');
const boldFont = path.resolve('infra/assets/mail-fonts/arialbd.ttf');
const doc = new PDFDocument({ size: 'A4', margin: 42, info: {
  Title: 'Schlussbericht – Teilnehmer und Fahrzeuge 2026',
  Author: 'MSC Oberlausitzer Dreiländereck e. V.'
} });
doc.pipe(fs.createWriteStream(outputPath));
doc.registerFont('Regular', regularFont);
doc.registerFont('Bold', boldFont);

const left = 42;
const width = doc.page.width - 84;
const row = (values, widths, y, options = {}) => {
  const height = options.height ?? 28;
  let x = left;
  values.forEach((value, index) => {
    doc.rect(x, y, widths[index], height).fillAndStroke(options.fill ?? '#ffffff', '#cbd5e1');
    doc.font(options.bold ? 'Bold' : 'Regular').fontSize(options.fontSize ?? 9).fillColor('#111827')
      .text(String(value), x + 7, y + 8, { width: widths[index] - 14, align: index === 0 ? 'left' : 'right', lineBreak: false });
    x += widths[index];
  });
  return y + height;
};

doc.font('Bold').fontSize(20).fillColor('#111827').text('Amtlicher Schlussbericht – Übersicht', left, 44, { width });
doc.font('Regular').fontSize(11).fillColor('#475569').text('12. Oberlausitzer Dreieck · Datenstand: 13.09.2026, 08:45 Uhr', left, 74, { width });
doc.moveTo(left, 98).lineTo(left + width, 98).lineWidth(2).strokeColor('#1d4f91').stroke();

doc.font('Bold').fontSize(13).fillColor('#111827').text('1. Zugelassene Nennungen und Fahrzeuge', left, 116, { width });
doc.font('Regular').fontSize(9).fillColor('#475569').text('Gezählt werden die Hauptfahrzeuge der zugelassenen, nicht gelöschten Nennungen.', left, 136, { width });

const vehicleWidths = [235, 90, 105, 81];
let y = 158;
y = row(['Kategorie', 'Zugelassen', 'Technisch abgenommen', 'Nicht abgenommen'], vehicleWidths, y, { bold: true, fill: '#e8eef7', fontSize: 8.5, height: 31 });
y = row(['Motorräder (Solo)', 160, 159, 1], vehicleWidths, y);
y = row(['Seitenwagen / Gespanne', 23, 21, 2], vehicleWidths, y, { fill: '#f8fafc' });
y = row(['Automobile inkl. Formel, Trabant und Sonderlauf', 84, 77, 7], vehicleWidths, y);
y = row(['Gesamt', 267, 257, 10], vehicleWidths, y, { bold: true, fill: '#e8eef7' });

doc.font('Bold').fontSize(13).fillColor('#111827').text('2. Teilnehmerstatus – Fahrer', left, y + 24, { width });
doc.font('Regular').fontSize(9).fillColor('#475569').text('Personenzahlen sind eindeutig gezählte Fahrer; Mehrfachstarter werden nur einmal gezählt.', left, y + 44, { width });

const personWidths = [270, 70, 171];
y += 66;
y = row(['Status', 'Anzahl', 'Erläuterung'], personWidths, y, { bold: true, fill: '#e8eef7' });
y = row(['Zugelassene Fahrer', 240, 'Grundgesamtheit'], personWidths, y);
y = row(['Bezahlt', 209, 'Rechnung bezahlt'], personWidths, y, { fill: '#f8fafc' });
y = row(['Teilnahmegebühr nicht erforderlich', 29, 'Zahlungsstatus vollständig'], personWidths, y);
y = row(['Zahlung noch offen', 2, 'Von 240 Fahrern'], personWidths, y, { fill: '#f8fafc' });
y = row(['Haftverzicht unterschrieben', 237, '3 Fahrer noch offen'], personWidths, y);
y = row(['Technisch abgenommen', 231, '257 Nennungen/Fahrzeuge'], personWidths, y, { fill: '#f8fafc' });
y = row(['Technisch nicht abgenommen', 10, '9 ausstehend, 1 nicht bestanden'], personWidths, y);
y = row(['Alle Voraussetzungen vollständig', 231, 'Bezahlt/gebührenfrei, HV und Technik'], personWidths, y, { bold: true, fill: '#e8eef7' });

doc.font('Bold').fontSize(11).fillColor('#111827').text('Ergänzende Angaben', left, y + 20, { width });
doc.font('Regular').fontSize(9).fillColor('#334155').text(
  'Haftverzicht Fahrer und reguläre Beifahrer: 279 von 282 erforderlichen Personen unterschrieben; 3 offen. ' +
  'Zusätzlich sind 20 Ersatzfahrzeuge hinterlegt. Diese sind nicht in den Hauptfahrzeugzahlen enthalten und wurden technisch nicht als bestanden erfasst.',
  left,
  y + 39,
  { width, lineGap: 2 }
);

doc.font('Regular').fontSize(7.5).fillColor('#64748b').text(
  'Quelle: Produktivdatenbank des Veranstaltungssystems. Statusdefinitionen: zugelassen = acceptance_status accepted; bezahlt = Rechnungsstatus paid; HV = erzeugtes unterschriebenes Haftverzichtsdokument; technisch abgenommen = tech_status passed.',
  left,
  758,
  { width, align: 'center', lineGap: 1 }
);

doc.end();
