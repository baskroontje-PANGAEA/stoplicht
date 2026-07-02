export interface PlateBox {
  // Scherm-AABB (voor tekenen en croppen)
  x: number; y: number; w: number; h: number;
  // PCA-gegevens (voor rotatie-correctie)
  angle: number;  // principaalashoek in radialen
  cx: number; cy: number; // centroïde
  pw: number; ph: number; // breedte/hoogte in eigen frame
}

// Detecteert Nederlandse gele kentekens via PCA-blob (werkt ook bij schuine platen).
export function detectPlates(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): PlateBox[] {
  const STEP = 3;
  const CELL = 20; // rasterceel voor blob-clustering

  // 1. Verzamel alle gele pixels
  const pts: Array<[number, number]> = [];
  for (let py = 0; py < imgH; py += STEP) {
    for (let px = 0; px < imgW; px += STEP) {
      const i = (py * imgW + px) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Geel-detectie: voldoende marge voor wisselende belichting, maar g>r*0.55
      // filtert oranje/rood (remlichten, banners) eruit — bij echt geel is g≥55% van r.
      if (r > 130 && g > 100 && b < 130 && r > b + 40 && g > b + 15 && g > r * 0.55) {
        pts.push([px, py]);
      }
    }
  }
  if (pts.length < 25) return [];

  // 2. Opzetten rastergrid + BFS blob-finding
  const gW = Math.ceil(imgW / CELL);
  const gH = Math.ceil(imgH / CELL);
  const grid = new Uint8Array(gW * gH);
  const cellPts = new Map<number, Array<[number, number]>>();

  for (const [x, y] of pts) {
    const ci = (y / CELL | 0) * gW + (x / CELL | 0);
    grid[ci] = 1;
    const arr = cellPts.get(ci);
    if (arr) arr.push([x, y]);
    else cellPts.set(ci, [[x, y]]);
  }

  const visited = new Uint8Array(gW * gH);
  const blobs: Array<Array<[number, number]>> = [];

  for (let ci = 0; ci < grid.length; ci++) {
    if (!grid[ci] || visited[ci]) continue;
    const blob: Array<[number, number]> = [];
    const q = [ci];
    visited[ci] = 1;
    while (q.length) {
      const c = q.pop()!;
      const arr = cellPts.get(c);
      if (arr) for (const p of arr) blob.push(p);
      const bx = c % gW, by = (c / gW) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = bx + dx, ny = by + dy;
          if (nx >= 0 && nx < gW && ny >= 0 && ny < gH) {
            const nc = ny * gW + nx;
            if (grid[nc] && !visited[nc]) { visited[nc] = 1; q.push(nc); }
          }
        }
      }
    }
    if (blob.length >= 20) blobs.push(blob);
  }

  // 3. PCA per blob → roterende bounding box
  const plates: PlateBox[] = [];

  for (const blob of blobs) {
    // Centroïde
    let mx = 0, my = 0;
    for (const [x, y] of blob) { mx += x; my += y; }
    mx /= blob.length; my /= blob.length;

    // Covariantie-matrix
    let cxx = 0, cxy = 0, cyy = 0;
    for (const [x, y] of blob) {
      const dx = x - mx, dy = y - my;
      cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
    }
    cxx /= blob.length; cxy /= blob.length; cyy /= blob.length;

    // Principaalhoekas
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const cos = Math.cos(angle), sin = Math.sin(angle);

    // Omhullende in gedraaid kader
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of blob) {
      const dx = x - mx, dy = y - my;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }

    const pw = maxU - minU, ph = maxV - minV;
    const ratio = pw / Math.max(ph, 1);

    // Aspect-ratio check in eigen frame van de plaat
    if (ratio < 2.2 || ratio > 9.5 || pw < 40 || ph < 6) continue;

    // Scherm-AABB voor canvas tekenen
    let x0 = imgW, x1 = 0, y0 = imgH, y1 = 0;
    for (const [x, y] of blob) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }

    plates.push({
      x: Math.max(0, x0 - STEP),
      y: Math.max(0, y0 - STEP),
      w: Math.min(imgW - x0, x1 - x0 + STEP * 2),
      h: Math.min(imgH - y0, y1 - y0 + STEP * 2),
      angle,
      cx: mx, cy: my,
      pw: pw + STEP * 2, ph: ph + STEP * 2,
    });
  }

  return plates.sort((a, b) => b.pw * b.ph - a.pw * a.ph).slice(0, 3);
}

// Schaal en deskew het kentekengebied voor Tesseract.
export function preprocessPlate(video: HTMLVideoElement, box: PlateBox): HTMLCanvasElement {
  const TARGET_H = 120;
  const { cx, cy, pw, ph, angle } = box;
  const absAngle = Math.abs(angle);

  const scale = TARGET_H / Math.max(ph, 1);
  const out = document.createElement('canvas');
  out.height = TARGET_H;
  out.width = Math.round(pw * scale);

  const ctx = out.getContext('2d')!;

  if (absAngle > 0.04) {
    // Deskew: draai het videoframe zodat de plaat recht staat
    const pad = Math.ceil(Math.sin(absAngle) * pw * 0.6 + 6);
    const srcW = pw + pad * 2, srcH = ph + pad * 2;
    const dstW = srcW * scale, dstH = srcH * scale;
    ctx.save();
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(-angle);
    ctx.drawImage(
      video,
      cx - srcW / 2, cy - srcH / 2, srcW, srcH,
      -dstW / 2, -dstH / 2, dstW, dstH,
    );
    ctx.restore();
  } else {
    ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
  }

  // Grijswaarden + drempel: geel → wit, letters → zwart
  const d = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const gray = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    const bw = gray > 110 ? 255 : 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = bw;
    d.data[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return out;
}
