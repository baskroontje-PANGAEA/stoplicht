export interface KentekenResult {
  kenteken: string;
  display: string;
  merk: string;
  model: string;
  bouwjaar: number | null;
  catalogusprijs: number | null;
  schatting0100: number | null;
  accelBron: 'carquery' | 'schatting' | null; // transparantie over databron
}

function displayKenteken(clean: string): string {
  if (clean.length === 6) return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 6)}`;
  if (clean.length === 7) return `${clean.slice(0, 1)}-${clean.slice(1, 4)}-${clean.slice(4, 7)}`;
  return clean;
}

// Empirische fallback: t ≈ 1.7 × (massa/vermogen)^0.7
function schat0100(massaKg: number, vermogenKw: number): number | null {
  if (!massaKg || !vermogenKw) return null;
  return Math.round(1.7 * Math.pow(massaKg / vermogenKw, 0.7) * 10) / 10;
}

export async function opzoekKenteken(raw: string): Promise<KentekenResult> {
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
  // Tel vermogen op over alle brandstofsoorten (correct voor PHEV/hybride)
  const maxVermogen = (brandstoffen as any[]).reduce((sum: number, f: any) => {
    return sum + (parseFloat(f.nettomaximumvermogen ?? '0') || 0);
  }, 0);

  // Probeer echte fabrieksspecificatie op te halen via carquery (server-side proxy)
  let schatting0100: number | null = schat0100(massaKg, maxVermogen);
  let accelBron: KentekenResult['accelBron'] = schatting0100 !== null ? 'schatting' : null;

  if (bouwjaar && v.merk && v.handelsbenaming) {
    try {
      const params = new URLSearchParams({
        make:  v.merk,
        model: v.handelsbenaming,
        year:  String(bouwjaar),
      });
      const cq = await fetch(`/api/carspecs?${params}`).then((r) => r.json());
      if (typeof cq.accel === 'number' && cq.accel > 0) {
        schatting0100 = cq.accel;
        accelBron = 'carquery';
      }
    } catch {
      // Formule blijft als fallback
    }
  }

  return {
    kenteken,
    display: displayKenteken(kenteken),
    merk: v.merk ?? '',
    model: v.handelsbenaming ?? '',
    bouwjaar,
    catalogusprijs,
    schatting0100,
    accelBron,
  };
}
