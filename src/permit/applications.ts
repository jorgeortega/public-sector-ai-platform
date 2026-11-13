import type { Tenant } from '../events/events';
import data from '../../data/applications.json';

// The nine fictional applications (data/applications.json), and the letter
// each one becomes: the model reads the letter, not the record.

export type Application = {
  id: string;
  tenant: Tenant;
  business: string;
  type: string;
  zone: string;
  staff: number;
  foodHandlerCertificate?: boolean;
  signSquareMetres?: number;
  outdoorSeats?: number;
  hours?: string;
  stateLicences?: boolean;
  kitchen?: string;
  largestEventGuests?: number;
  sellsFood?: boolean;
  flammableGoods?: boolean;
  applicant: string;
};

// Imported, not read from disk, so trigger.dev's bundle carries it.
export const APPLICATIONS = data.applications as Application[];

export function application(id: string): Application {
  const found = APPLICATIONS.find((app) => app.id === id);
  if (!found) throw new Error(`No fictional application ${id}.`);
  return found;
}

// A renewal in the burst: nothing changed since last year.
export const isRenewal = (id: string) => /-renewal-\d{4}$/.test(id);

export function letterFor(app: Application): string {
  const lines = [
    `Application ${app.id}`,
    `Dear permit office,`,
    `I am applying for a business permit for ${app.business}, a ${app.type} in zone ${app.zone}, with ${app.staff} staff.`,
  ];
  if (app.foodHandlerCertificate !== undefined) lines.push(app.foodHandlerCertificate ? 'A food handler certificate is attached.' : 'We do not have a food handler certificate yet.');
  if (app.stateLicences !== undefined) lines.push(app.stateLicences ? 'Everyone who works on clients holds a state licence.' : 'Not everyone who works on clients holds a state licence yet.');
  if (app.signSquareMetres) lines.push(`The sign facing the street will be ${app.signSquareMetres} square metres.`);
  if (app.outdoorSeats !== undefined) lines.push(`We would like ${app.outdoorSeats} seats on the sidewalk.`);
  if (app.kitchen) lines.push(`We cook in a ${app.kitchen}.`);
  if (app.largestEventGuests) lines.push(`Our largest event serves ${app.largestEventGuests} guests.`);
  if (app.sellsFood === false) lines.push('We do not sell food.');
  if (app.flammableGoods) lines.push('We sell paint and other flammable goods.');
  if (app.hours) lines.push(`We will be open ${app.hours}.`);
  lines.push(`Signed, ${app.applicant}.`);
  return lines.join('\n');
}
