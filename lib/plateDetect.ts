export interface PlateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Detecteert Nederlandse gele kentekens via rij-scanning op gele pixels.
// Stap 3 pixels overslaan voor snelheid; filtert op aspect ratio (~4.7:1).
export function detectPlates(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): PlateBox[] {
  const step = 3;
  const rowMin: number[] = [];
  const rowMax: number[] = [];

  for (let py = 0; py < imgH; py += step) {
    let minX = -1, maxX = -1;
    for (let px = 0; px < imgW; px += step) {
      const i = (py * imgW + px) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Kenteken-geel: R en G hoog, B laag
      if (r > 165 && g > 140 && b < 95 && r > b + 85 && g > b + 55) {
        if (minX === -1) minX = px;
        maxX = px;
      }
    }
    rowMin.push(minX);
    rowMax.push(maxX);
  }

  const plates: PlateBox[] = [];
  let runStart = -1;

  for (let ri = 0; ri <= rowMin.length; ri++) {
    const hasYellow = ri < rowMin.length && rowMin[ri] !== -1;
    if (hasYellow) {
      if (runStart === -1) runStart = ri;
    } else if (runStart !== -1) {
      const runEnd = ri - 1;
      let minX = Infinity, maxX = -Infinity;
      for (let j = runStart; j <= runEnd; j++) {
        if (rowMin[j] !== -1) {
          minX = Math.min(minX, rowMin[j]);
          maxX = Math.max(maxX, rowMax[j]);
        }
      }
      const rw = maxX - minX;
      const rh = (runEnd - runStart + 1) * step;
      const ratio = rw / rh;

      // Standaard NL-kenteken: ratio 4-6.5, minimale pixels
      if (ratio >= 2.8 && ratio <= 7.5 && rw >= 55 && rh >= 8) {
        plates.push({
          x: Math.max(0, minX - step),
          y: Math.max(0, runStart * step - step),
          w: rw + step * 2,
          h: rh + step * 2,
        });
      }
      runStart = -1;
    }
  }

  // Geef grootste kandidaten terug (sorteer op oppervlak)
  return plates.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 3);
}

// Schaal en threshold het plate-gebied voor Tesseract-invoer.
// Geel wordt wit, zwarte letters blijven zwart → donker-op-wit voor Tesseract.
export function preprocessPlate(
  video: HTMLVideoElement,
  box: PlateBox,
): HTMLCanvasElement {
  const TARGET_H = 80;
  const scale = TARGET_H / Math.max(box.h, 1);
  const out = document.createElement('canvas');
  out.height = TARGET_H;
  out.width = Math.round(box.w * scale);

  const ctx = out.getContext('2d')!;
  ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);

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
