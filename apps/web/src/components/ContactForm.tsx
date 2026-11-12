'use client';

import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { ContactState } from '@/app/[locale]/contact-actions';

type Props = {
  action: (form: FormData) => Promise<ContactState>;
  locale: 'de' | 'en';
  /** Signed proof-of-work challenge for this page view (core/contact.ts). */
  challenge: string;
};

type Check = 'idle' | 'working' | 'done' | 'failed';

/** Leading zero bits of a digest; the same rule as leadingZeroBits in core/contact.ts. */
function zeroBits(d: Uint8Array): number {
  let bits = 0;
  for (const byte of d) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Finds a nonce so that SHA-256("salt:nonce") starts with enough zero bits. */
async function solve(token: string): Promise<string> {
  const [salt, , d] = token.split('.');
  const difficulty = Number(d);
  const enc = new TextEncoder();
  const BATCH = 512;
  for (let start = 0; start < 50_000_000; start += BATCH) {
    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${start + i}`)),
      ),
    );
    const hit = digests.findIndex((x) => zeroBits(new Uint8Array(x)) >= difficulty);
    if (hit >= 0) return String(start + hit);
  }
  throw new Error('no solution');
}

/**
 * The contact form. "I am human" makes the browser solve a small proof of work (a second or two),
 * a hidden field catches bots that fill in everything, and the server checks both again.
 */
export function ContactForm({ action, locale, challenge: initial }: Props) {
  const t = useTranslations('Contact');
  const [state, setState] = useState<ContactState>({});
  const [pending, start] = useTransition();
  const [check, setCheck] = useState<Check>('idle');
  const [nonce, setNonce] = useState('');
  const token = state.challenge ?? initial;
  const solving = useRef<string | null>(null);

  // A new challenge from the server (old one expired or used) needs a new tick.
  useEffect(() => {
    setCheck('idle');
    setNonce('');
  }, [token]);

  const runCheck = async () => {
    if (check === 'working' || check === 'done') return;
    setCheck('working');
    solving.current = token;
    try {
      const n = await solve(token);
      if (solving.current !== token) return;
      setNonce(n);
      setCheck('done');
    } catch {
      setCheck('failed');
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (check !== 'done') {
      setState((s) => ({ ...s, errors: { ...s.errors, human: 'human' } }));
      return;
    }
    const data = new FormData(e.currentTarget);
    start(async () => setState(await action(data)));
  };

  if (state.sent) {
    return (
      <div className="contact-sent" role="status">
        <h2>{t('sentTitle')}</h2>
        <p>{t('sentText', { email: state.email ?? '' })}</p>
      </div>
    );
  }

  const errors = state.errors ?? {};
  const values = state.values ?? {};
  const humanError = check === 'done' ? undefined : errors.human;
  const fieldErrors = Object.keys(errors).filter((k) => k !== 'human' && k !== '_').length > 0;

  const field = (
    name: 'name' | 'email' | 'subject' | 'message',
    opts: { type?: string; area?: boolean; autoComplete?: string; required?: boolean } = {},
  ) => {
    const code = errors[name];
    const id = `c-${name}`;
    const hint = name === 'email' ? t('emailHint') : undefined;
    const common = {
      id,
      name,
      defaultValue: values[name] ?? '',
      required: opts.required ?? true,
      autoComplete: opts.autoComplete,
      'aria-invalid': code ? true : undefined,
      'aria-describedby': code ? `${id}-err` : hint ? `${id}-hint` : undefined,
    } as const;
    return (
      <label className={code ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{t(name)}</span>
        {opts.area ? (
          <textarea rows={7} maxLength={5000} {...common} />
        ) : (
          <input type={opts.type ?? 'text'} {...common} />
        )}
        {code ? (
          <small id={`${id}-err`} className="field__error">
            {t(`errors.${code}` as never)}
          </small>
        ) : (
          hint && (
            <small id={`${id}-hint`} className="muted">
              {hint}
            </small>
          )
        )}
      </label>
    );
  };

  return (
    <form className="contact-form stack" onSubmit={onSubmit} noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="challenge" value={token} />
      <input type="hidden" name="nonce" value={nonce} />
      {(fieldErrors || errors._) && (
        <p className="notice notice--warn" role="alert">
          {errors._ ? t(`errors.${errors._}` as never) : t('errorsTitle')}
        </p>
      )}
      <div className="contact-pair">
        {field('name', { autoComplete: 'name' })}
        {field('email', { type: 'email', autoComplete: 'email' })}
      </div>
      {field('subject', { required: false })}
      {field('message', { area: true })}
      {/* Honeypot: hidden from people and screen readers; bots tend to fill it in. */}
      <div className="contact-hp" aria-hidden="true">
        <label htmlFor="c-website">Website</label>
        <input id="c-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className={humanError ? 'human-check human-check--error' : 'human-check'}>
        <label className="check">
          <input
            type="checkbox"
            checked={check === 'done' || check === 'working'}
            disabled={check === 'working' || check === 'done'}
            onChange={runCheck}
            aria-describedby="c-human-status"
          />
          <span>{t('human')}</span>
        </label>
        <small
          id="c-human-status"
          className={humanError || check === 'failed' ? 'field__error' : 'muted'}
          aria-live="polite"
        >
          {check === 'working'
            ? t('humanWorking')
            : check === 'done'
              ? t('humanDone')
              : check === 'failed'
                ? t('humanFailed')
                : humanError
                  ? t(`errors.${humanError}` as never)
                  : t('humanHint')}
        </small>
      </div>
      <button type="submit" className="btn btn--accent" disabled={pending}>
        {pending ? t('sending') : t('submit')}
      </button>
      <p className="muted small">
        {t.rich('privacy', { link: (c) => <Link href="/datenschutz">{c}</Link> })}
      </p>
    </form>
  );
}
