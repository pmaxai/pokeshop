import 'server-only';
import { cache } from 'react';
import { getSetting } from './config';

export type Company = {
  /** Legal name: legal notice, invoices and e-mail footers only. */
  name: string;
  /** How shop pages and legal texts name the operator. */
  public_name?: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  /** Business activity (Gewerbe), e.g. "Handel mit Waren aller Art". */
  trade?: string | null;
  register_number?: string | null;
  register_court?: string | null;
  vat_id?: string | null;
  managing_director?: string | null;
  chamber: string;
  supervisory_authority: string;
  trade_licence: string | null;
};

export const getCompany = cache(() =>
  getSetting<Company>('company', {
    name: '',
    public_name: 'Overpriced Cardboard',
    street: '',
    postcode: '',
    city: '',
    country: 'AT',
    email: 'order@overpricedcardboard.com',
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
