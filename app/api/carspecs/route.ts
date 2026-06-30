import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy naar carqueryapi.com — vermijdt CORS en mixed-content.
// Geeft de 0-100 km/h tijd terug (omgerekend van 0-60 mph) voor het beste
// matchende trim, of { accel: null } als er geen data is.
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const make  = (sp.get('make')  ?? '').toLowerCase().trim();
  const model = (sp.get('model') ?? '').trim();          // RDW handelsbenaming
  const year  = sp.get('year') ?? '';

  if (!make || !model) return NextResponse.json({ accel: null });

  // Eerste woord van de handelsbenaming = basismodel (XC90, Golf, Taycan, ...)
  const baseModel = model.split(/\s+/)[0].toLowerCase();

  try {
    const url = new URL('https://www.carqueryapi.com/api/0.3/');
    url.searchParams.set('cmd', 'getTrims');
    url.searchParams.set('make', make);
    url.searchParams.set('model', baseModel);
    if (year) url.searchParams.set('year', year);
    url.searchParams.set('full_results', '1');

    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 6_000); // max 6s wachten
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        next: { revalidate: 604_800 }, // 7 dagen cachen per model+jaar
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

    // Beste match: trim wiens naam de meeste woorden deelt met de handelsbenaming
    const ref = model.toUpperCase();
    let best = withAccel[0];
    let bestScore = -1;
    for (const t of withAccel) {
      const words = (t.model_trim ?? '').toUpperCase().split(/\s+/);
      const score = words.filter((w: string) => w.length > 1 && ref.includes(w)).length;
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
