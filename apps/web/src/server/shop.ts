import 'server-only';
import { cache } from 'react';
import { getSetting } from './config';

export type Company = {
  name: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  register_number: string;
  register_court: string;
  vat_id: string;
  managing_director: string;
  chamber: string;
  supervisory_authority: string;
  trade_licence: string | null;
};

export const getCompany = cache(() =>
  getSetting<Company>('company', {
    name: 'Antalyse GmbH',
    street: '',
    postcode: '',
    city: '',
    country: 'AT',
    email: 'bestellung@pokemonkarten.at',
    register_number: '',
    register_court: '',
    vat_id: '',
    managing_director: '',
    chamber: '',
    supervisory_authority: '',
    trade_licence: null,
  }),
);

/** First value of a search param as string. */
export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
/** All values of a search param. */
export function many(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).slice(0, 30);
}
