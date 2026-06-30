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

const SHOW_MS = 60_000; // 1 minuut zichtbaar

function formatPrice(cents: number | null): string {
  if (!cents) return '—';
  return `€ ${cents.toLocaleString('nl-NL')}`;
}

export default function PlateBar({ entries }: Props) {
  const [now, setNow] = useState(Date.now());

  // Herteken elke 5s zodat verlopen kaarten verdwijnen
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const visible = entries.filter((e) => now - e.detectedAt < SHOW_MS);
  if (!visible.length) return null;

  return (
    <div className={styles.bar}>
      {visible.map((e) => (
        <div key={e.kenteken + e.detectedAt} className={styles.entry}>
          <span className={styles.kenteken}>{e.display}</span>
          <span className={styles.divider}>•</span>
          <span className={styles.meta}>
            {e.merk} {e.model}
          </span>
          <span className={styles.divider}>•</span>
          <span className={styles.meta}>{e.bouwjaar ?? '—'}</span>
          <span className={styles.divider}>•</span>
          <span className={styles.meta}>{formatPrice(e.catalogusprijs)}</span>
          {e.schatting0100 && (
            <>
              <span className={styles.divider}>•</span>
              <span className={styles.meta}>0–100: ~{e.schatting0100}s</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
