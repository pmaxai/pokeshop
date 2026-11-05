import { getTranslations } from 'next-intl/server';
import type { SetSummary } from '@pokeshop/core/storefront';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

export async function SetList({ sets, locale }: { sets: SetSummary[]; locale: Locale }) {
  const t = await getTranslations('Sets');
  return (
    <ul className="set-list">
      {sets.map((s) => (
        <li key={s.setCode}>
          <Link href={{ pathname: '/sets/[set]', params: { set: s.setCode } }} className="set-item">
            {s.logo ? (
              <img
                src={`/media/card/${s.logo}.webp`}
                alt=""
                loading="lazy"
                width={120}
                height={48}
              />
            ) : (
              <span />
            )}
            <span>
              <strong>{s.name}</strong>
              <span>
                {s.series ? `${s.series}, ` : ''}
                {t('forSale', { count: s.forSale })}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
