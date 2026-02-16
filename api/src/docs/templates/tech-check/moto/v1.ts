import { format } from 'node:util';

type TemplateInput = {
  eventName: string;
  eventStartsAt: string;
  eventEndsAt: string;
  className: string;
  driverName: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  startNumber: string | null;
};

export const renderMotoChecklistV1 = (input: TemplateInput): string[] => [
  format('Event: %s', input.eventName),
  format('Datum: %s bis %s', input.eventStartsAt, input.eventEndsAt),
  format('Klasse: %s', input.className),
  '',
  format('Fahrer: %s', input.driverName),
  format('Fahrzeug: %s %s', input.vehicleMake ?? '-', input.vehicleModel ?? '-'),
  format('Baujahr: %s', input.vehicleYear ?? '-'),
  format('Startnummer: %s', input.startNumber ?? '-'),
  '',
  'Technische Abnahme MOTO (v1)',
  '- Bremsen vorne/hinten',
  '- Lenkkopflager / Gabel',
  '- Kette/Ritzel',
  '- Reifen/Felgen',
  '- Sicherheitsrelevante Verschraubungen',
  '',
  'Prüfer: ________________________________',
  'Datum: _________________________________'
];
