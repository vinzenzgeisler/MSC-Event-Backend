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

export const renderAutoChecklistV1 = (input: TemplateInput): string[] => [
  format('Event: %s', input.eventName),
  format('Datum: %s bis %s', input.eventStartsAt, input.eventEndsAt),
  format('Klasse: %s', input.className),
  '',
  format('Fahrer: %s', input.driverName),
  format('Fahrzeug: %s %s', input.vehicleMake ?? '-', input.vehicleModel ?? '-'),
  format('Baujahr: %s', input.vehicleYear ?? '-'),
  format('Startnummer: %s', input.startNumber ?? '-'),
  '',
  'Technische Abnahme AUTO (v1)',
  '- Bremsanlage',
  '- Lenkung',
  '- Reifen/Felgen',
  '- Sicherheitsgurt / Sitz',
  '- Feuerlöscher (falls erforderlich)',
  '',
  'Prüfer: ________________________________',
  'Datum: _________________________________'
];
