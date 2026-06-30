import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy naar carqueryapi.com — vermijdt CORS en mixed-content.
// Zoekt ZONDER jaar-filter zodat varianten als Taycan GTS/Turbo/4S altijd gevonden worden;
// scoort trims op naamovereenkomst (dominant) + jaarnabijheid (tiebreaker).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const make  = (sp.get('make')  ?? '').toLowerCase().trim();
  const model = (sp.get('model') ?? '').trim();          // RDW handelsbenaming
  const year  = sp.get('year') ?? '';

  if (!make || !model) return NextResponse.json({ accel: null });

  // Eerste woord van de handelsbenaming = basismodel (XC90, Golf, Taycan, …)
  const baseModel = model.split(/\s+/)[0].toLowerCase();

  try {
    const url = new URL('https://www.carqueryapi.com/api/0.3/');
    url.searchParams.set('cmd', 'getTrims');
    url.searchParams.set('make', make);
    url.searchParams.set('model', baseModel);
    // Geen jaar-filter: haal alle jaren op zodat varianten altijd gevonden worden.
    url.searchParams.set('full_results', '1');

    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 6_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        next: { revalidate: 604_800 }, // 7 dagen cachen per model
      });
    } finally {
      clearTimeout(tId);
    }

    if (!res!.ok) return NextResponse.json({ accel: null });

    const data = await res.json();
    const trims: any[] = data.Trims ?? [];

    // Alleen trims met geldige acceleratiedata
    const withAccel = trims.filter((t) => parseFloat(t.model_0_to_60 ?? '') > 0);
    if (!withAccel.length) return NextResponse.json({ accel: null });

    // Beste match: naamovereenkomst (dominant) + jaarnabijheid (tiebreaker)
    const ref = model.toUpperCase();
    const targetYear = year ? parseInt(year) : 0;
    let best = withAccel[0];
    let bestScore = -1;

    for (const t of withAccel) {
      // Naamovereenkomst: hoeveel woorden uit de trimnaam staan in de handelsbenaming?
      const words = (t.model_trim ?? '').toUpperCase().split(/\s+/);
      const nameScore = words.filter((w: string) => w.length > 1 && ref.includes(w)).length;

      // Jaarnabijheid: exact jaar = 1, elk jaar erbij → dichter bij 0
      const trimYear = parseInt(t.model_year ?? '0') || 0;
      const yearDiff = targetYear && trimYear ? Math.abs(targetYear - trimYear) : 5;
      const yearScore = 1 / (yearDiff + 1);

      // Naam weegt 3× zwaarder dan jaar (variant GTS vs Turbo > bouwjaar 2021 vs 2022)
      const score = nameScore * 3 + yearScore;
      if (score > bestScore) { bestScore = score; best = t; }
    }

    const mph060 = parseFloat(best.model_0_to_60);
    // 0-60 mph = 0-96.6 km/h; correctiefactor naar 0-100 km/h ≈ 1.07
    const kmh0100 = Math.round(mph060 * 1.07 * 10) / 10;

    return NextResponse.json({ accel: kmh0100, trim: best.model_trim ?? null });
  } catch {
    return NextResponse.json({ accel: null });
  }
}
