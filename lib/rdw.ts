export interface KentekenResult {
  kenteken: string;
  display: string;
  merk: string;
  model: string;
  bouwjaar: number | null;
  catalogusprijs: number | null;
  vermogenKw: number | null;   // totaal systeemvermogen (kW), uit RDW
  vermogenPk: number | null;   // kW × 1.36 (metrisch pk)
  accel0100: number | null;    // 0-100 km/h uit carquery — alleen echte fabrieksdata
  accelBron: 'carquery' | null;
}

export function displayKenteken(clean: string): string {
  if (clean.length === 6) return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 6)}`;
  if (clean.length === 7) return `${clean.slice(0, 1)}-${clean.slice(1, 4)}-${clean.slice(4, 7)}`;
  return clean;
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

  // Per brandstofentry nemen we het maximum van alle drie vermogenvelden.
  // RDW bewaart ICE-vermogen in nettomaximumvermogen, EV-vermogen in
  // netto_max_vermogen_elektrisch (peak) of nominaal_continu_maximumvermogen (continu).
  // Math.max voorkomt problemen met spellingsvarianten van brandstof_omschrijving.
  // Bij PHEV (benzine + elektrisch entries): beide entries worden opgeteld.
  let totalKw = 0;
  for (const f of brandstoffen as any[]) {
    const ice  = parseFloat(f.nettomaximumvermogen             ?? '0') || 0;
    const evP  = parseFloat(f.netto_max_vermogen_elektrisch    ?? '0') || 0;
    const evC  = parseFloat(f.nominaal_continu_maximumvermogen ?? '0') || 0;
    totalKw += Math.max(ice, evP, evC);
  }
  const vermogenKw = totalKw > 0 ? Math.round(totalKw) : null;
  const vermogenPk = vermogenKw ? Math.round(vermogenKw * 1.36) : null;

  return {
    kenteken,
    display: displayKenteken(kenteken),
    merk: v.merk ?? '',
    model: v.handelsbenaming ?? '',
    bouwjaar,
    catalogusprijs,
    vermogenKw,
    vermogenPk,
    accel0100: null,
    accelBron: null,
  };
}

// Achtergrond-update: echte 0-100 via carquery (1-4s, blokkeert niets).
// Roep aan nádat het RDW-resultaat al getoond wordt.
export async function opzoekCarquery(
  merk: string,
  model: string,
  jaar: number | null,
): Promise<number | null> {
  if (!merk || !model) return null;
  try {
    const params = new URLSearchParams({ make: merk, model });
    if (jaar) params.set('year', String(jaar));
    const res = await fetch(`/api/carspecs?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.accel === 'number' && data.accel > 0 ? data.accel : null;
  } catch {
    return null;
  }
}
