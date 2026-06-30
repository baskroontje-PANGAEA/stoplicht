export interface KentekenResult {
  kenteken: string;
  display: string;
  merk: string;
  model: string;
  bouwjaar: number | null;
  catalogusprijs: number | null;
  schatting0100: number | null;
  accelBron: 'carquery' | 'schatting' | null;
}

export function displayKenteken(clean: string): string {
  if (clean.length === 6) return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 6)}`;
  if (clean.length === 7) return `${clean.slice(0, 1)}-${clean.slice(1, 4)}-${clean.slice(4, 7)}`;
  return clean;
}

// Empirische fallback: t ≈ 1.7 × (massa/vermogen)^0.7
function schat0100(massaKg: number, vermogenKw: number): number | null {
  if (!massaKg || !vermogenKw) return null;
  return Math.round(1.7 * Math.pow(massaKg / vermogenKw, 0.7) * 10) / 10;
}

// Snelle lookup: alleen RDW (~300-500ms). Toon dit direct.
export async function opzoekKentekenRdw(raw: string): Promise<KentekenResult> {
  const kenteken = raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (kenteken.length < 4) throw new Error('Ongeldig kenteken');

  const [voertuigen, brandstoffen] = await Promise.all([
    fetch(`https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${kenteken}`)
      .then((r) => { if (!r.ok) throw new Error('RDW fout'); return r.json(); }),
    fetch(`https://opendata.rdw.nl/resource/8ys7-d773.json?kenteken=${kenteken}`)
      .then((r) => r.json())
      .catch(() => []),
  ]);

  if (!voertuigen?.length) throw new Error('Niet gevonden');
  const v = voertuigen[0];

  const dateStr = String(v.datum_eerste_toelating ?? '');
  const bouwjaar = dateStr.length >= 4 ? parseInt(dateStr.slice(0, 4)) : null;
  const catalogusprijs = v.catalogusprijs ? parseInt(v.catalogusprijs) : null;

  const massaKg = parseInt(v.massa_rijklaar ?? '0') || 0;
  // Tel vermogen op over alle brandstofsoorten.
  // Benzine/diesel:  f.nettomaximumvermogen
  // Elektrisch:      f.netto_max_vermogen_elektrisch  (ander veld bij EV/PHEV)
  // Per entry nemen we het maximum van beide velden, dan sommeren we.
  const maxVermogen = (brandstoffen as any[]).reduce((sum: number, f: any) => {
    const ice = parseFloat(f.nettomaximumvermogen          ?? '0') || 0;
    const ev  = parseFloat(f.netto_max_vermogen_elektrisch ?? '0') || 0;
    return sum + Math.max(ice, ev);
  }, 0);

  const s0100 = schat0100(massaKg, maxVermogen);

  return {
    kenteken,
    display: displayKenteken(kenteken),
    merk: v.merk ?? '',
    model: v.handelsbenaming ?? '',
    bouwjaar,
    catalogusprijs,
    schatting0100: s0100,
    accelBron: s0100 !== null ? 'schatting' : null,
  };
}

// Achtergrond-update: echte 0-100 via carquery (1-4s, maar blokkeert niets).
// Roep aan nádat het RDW-resultaat al getoond wordt.
export async function opzoekCarquery(
  merk: string,
  model: string,
  jaar: number | null,
): Promise<number | null> {
  if (!merk || !model || !jaar) return null;
  try {
    const params = new URLSearchParams({ make: merk, model, year: String(jaar) });
    const res = await fetch(`/api/carspecs?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.accel === 'number' && data.accel > 0 ? data.accel : null;
  } catch {
    return null;
  }
}
