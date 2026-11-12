'use server';

import { headers } from 'next/headers';
import {
  ChallengeUsed,
  createChallenge,
  recordContactMessage,
  validateContact,
  verifyChallenge,
} from '@pokeshop/core/contact';
import { apiMasterKey, db } from '@/server/config';
import { clientIp, rateLimited } from '@/server/rate-limit';

/** What the contact form gets back: sent, or the errors and the values to show again. */
export type ContactState = {
  sent?: boolean;
  email?: string;
  errors?: Record<string, string>;
  values?: Record<string, string>;
  /** A fresh challenge when the old one can no longer be used. */
  challenge?: string;
};

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

/** At most this many messages per visitor address in the window. */
const LIMIT = 5;
const WINDOW_MS = 15 * 60_000;

export async function contactAction(form: FormData): Promise<ContactState> {
  const locale = str(form, 'locale') === 'de' ? 'de' : 'en';
  const values = {
    name: str(form, 'name'),
    email: str(form, 'email'),
    subject: str(form, 'subject'),
    message: str(form, 'message'),
  };
  // Honeypot: a field people never see. Bots that fill it get a "sent" and nothing is stored.
  if (str(form, 'website')) return { sent: true, email: values.email };

  const v = validateContact(values);
  const check = verifyChallenge(apiMasterKey(), str(form, 'challenge'), str(form, 'nonce'));
  const errors: Record<string, string> = v.ok ? {} : { ...v.errors };
  let challenge: string | undefined;
  if (!check.ok) {
    errors.human =
      check.problem === 'expired' || check.problem === 'too_fast' ? check.problem : 'human';
    if (check.problem !== 'unsolved' && check.problem !== 'missing') {
      challenge = createChallenge(apiMasterKey());
    }
  }
  if (!v.ok || !check.ok) return { errors, values, challenge };

  if (rateLimited(`contact:${clientIp(await headers())}`, LIMIT, WINDOW_MS)) {
    return { errors: { _: 'too_many' }, values };
  }
  try {
    await recordContactMessage(db(), v.data, locale, check.salt);
  } catch (e) {
    if (!(e instanceof ChallengeUsed)) throw e;
    return { errors: { human: 'human' }, values, challenge: createChallenge(apiMasterKey()) };
  }
  return { sent: true, email: v.data.email };
}
