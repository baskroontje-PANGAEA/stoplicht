'use client';

import { useEffect, useState } from 'react';
import type { KentekenResult } from '@/lib/rdw';
import styles from './PlateBar.module.css';

export interface PlateEntry extends KentekenResult {
  detectedAt: number;
}

interface Props {
  entries: PlateEntry[];
}

const SHOW_MS = 60_000;

export default function PlateBar({ entries }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const visible = entries.filter((e) => now - e.detectedAt < SHOW_MS);
  if (!visible.length) return null;

  return (
    <div className={styles.bar}>
      {visible.map((e) => {
        const merkModel = [e.merk, e.model].filter(Boolean).join(' ') || null;
        const stats = [
          e.bouwjaar ?? null,
          e.catalogusprijs ? `€ ${e.catalogusprijs.toLocaleString('nl-NL')}` : null,
          e.schatting0100 ? `0–100: ~${e.schatting0100}s` : null,
        ].filter(Boolean).join('  ·  ');

        return (
          <div key={e.kenteken + e.detectedAt} className={styles.entry}>
            <span className={styles.kenteken}>{e.display}</span>
            <div className={styles.details}>
              {merkModel && <span className={styles.merkModel}>{merkModel}</span>}
              {stats && <span className={styles.stats}>{stats}</span>}
              {!merkModel && !stats && <span className={styles.stats}>Niet gevonden in RDW</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
