'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Detector.module.css';
import PlateBar, { type PlateEntry } from './PlateBar';
import { detectPlates, preprocessPlate, type PlateBox } from '@/lib/plateDetect';
import { opzoekKentekenRdw, opzoekCarquery, displayKenteken } from '@/lib/rdw';

const VERSION = '1.5.8';

type LightState = 'none' | 'red' | 'yellow' | 'green' | 'unknown';
type AppStatus = 'idle' | 'loading' | 'ready' | 'error';

// Nederlandse kentekens bevatten nooit I of O — die worden vervangen door 1 en 0.
// Valideer daarna het patroon (sidecodes 1-10).
const NL_SIDECODES = [
  /^[A-Z]{2}\d{4}$/,           // SC1: LL-NN-NN
  /^\d{2}[A-Z]{2}\d{2}$/,      // SC2: NN-LL-NN
  /^\d{4}[A-Z]{2}$/,           // SC3: NN-NN-LL
  /^[A-Z]{2}\d{2}[A-Z]{2}$/,   // SC4: LL-NN-LL
  /^\d{2}[A-Z]{4}$/,           // SC5: NN-LL-LL
  /^[A-Z]{4}\d{2}$/,           // SC6: LL-LL-NN
  /^[A-Z]{2}\d{3}[A-Z]$/,      // SC7: LL-NNN-L  (KV-220-V → KV220V)
  /^[A-Z]\d{3}[A-Z]{2}$/,      // SC8: L-NNN-LL  (P-936-RT → P936RT)
  /^\d{2}[A-Z]{3}\d$/,          // SC9:  NN-LLL-N
  /^\d[A-Z]{3}\d{2}$/,          // SC10: N-LLL-NN
  /^[A-Z]\d{2}[A-Z]{3}$/,       // SC11: L-NN-LLL  (V-94-HLL, vanaf ~2019)
];

function cleanKenteken(raw: string): string | null {
  const s = raw
    .toUpperCase()
    .replace(/I/g, '1')   // I bestaat niet op NL-kentekens
    .replace(/O/g, '0')   // O bestaat niet op NL-kentekens
    .replace(/[^A-Z0-9]/g, '');
  // Alle NL-sidecodes zijn exact 6 tekens. Schuif een raam van 6 chars over de
  // volledige OCR-string — werkt ook als Tesseract extra tekens leest zoals
  // "NL" van de EU-strip of een losstaand karakter aan de rand.
  for (let i = 0; i <= s.length - 6; i++) {
    const sub = s.slice(i, i + 6);
    if (NL_SIDECODES.some((p) => p.test(sub))) return sub;
  }
  return null;
}

// Genereer OCR-alternatieven door veelvoorkomende cijfer/letter-verwisselingen
// per positie te proberen. RDW is de autoriteit: alleen een hit in RDW telt.
const OCR_SWAPS: Record<string, string> = { S: '5', '5': 'S', B: '8', '8': 'B', G: '6', '6': 'G' };
function ocrAlternatives(s: string): string[] {
  const alts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const repl = OCR_SWAPS[s[i]];
    if (!repl) continue;
    const alt = s.slice(0, i) + repl + s.slice(i + 1);
    if (NL_SIDECODES.some((p) => p.test(alt))) alts.push(alt);
  }
  return alts;
}

// Positie-bucket voor stabiliteitstracking van meerdere platen tegelijk.
function plateBucket(p: PlateBox): string {
  return `${Math.round(p.cx / 150)}_${Math.round(p.cy / 150)}`;
}

// Module-level Tesseract worker (hergebruikt over meerdere OCR-runs)
let _ocrWorker: any = null;
async function getOCRWorker() {
  if (_ocrWorker) return _ocrWorker;
  const { createWorker } = await import('tesseract.js');
  _ocrWorker = await createWorker('eng', 1, { logger: () => {} });
  await _ocrWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '8', // single word (kenteken = één woord zonder spaties)
  });
  return _ocrWorker;
}

function playDeepBeep(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = 220;
  gain.gain.setValueAtTime(0.85, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.8);
}

function playHighBeep(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = 1100;
  gain.gain.setValueAtTime(0.75, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.4);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function detectLightColor(
  data: Uint8ClampedArray,
  imgW: number, imgH: number,
  x: number, y: number, w: number, h: number,
): LightState {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(imgW, Math.floor(x + w));
  const y1 = Math.min(imgH, Math.floor(y + h));
  const actualH = y1 - y0;
  if (actualH < 3) return 'unknown';
  const sectionH = actualH / 3;

  const maxSV = [0, 0, 0];
  const hueOK = [0, 0, 0];

  for (let py = y0; py < y1; py++) {
    const sec = Math.min(2, Math.floor((py - y0) / sectionH));
    for (let px = x0; px < x1; px++) {
      const i = (py * imgW + px) * 4;
      const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (v > 0.40 && s > 0.15) {
        const sv = s * v;
        if (sv > maxSV[sec]) maxSV[sec] = sv;
        if (sec === 0 && (h <= 25 || h >= 335)) hueOK[0] += sv;
        if (sec === 1 && h > 25 && h < 75)      hueOK[1] += sv;
        if (sec === 2 && h >= 70 && h <= 175)   hueOK[2] += sv;
      }
    }
  }

  const maxVal = Math.max(...maxSV);
  if (maxVal < 0.18) return 'unknown';
  const score = maxSV.map((m, i) => m * (hueOK[i] > 0 ? 1.5 : 1.0));
  return (['red', 'yellow', 'green'] as LightState[])[score.indexOf(Math.max(...score))];
}

export default function Detector() {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const zoomRef     = useRef<HTMLCanvasElement>(null);
  const modelRef    = useRef<any>(null);
  const audioRef    = useRef<AudioContext | null>(null);
  const prevLightRef  = useRef<LightState>('none');
  const noneCountRef  = useRef(0);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef    = useRef(false);
  const frameRef      = useRef(0);
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Kenteken-tracking (per positie-bucket, zodat meerdere platen tegelijk werken)
  const stablePlatesRef  = useRef(new Map<string, PlateBox & { count: number }>());
  const ocrBusyRef       = useRef(false);
  const nextOCRAtRef     = useRef(0);
  const seenPlatesRef    = useRef<Set<string>>(new Set());

  // Camera-zoom: inzoomen zodra een gele plaat gevonden is
  const videoTrackRef    = useRef<MediaStreamTrack | null>(null);
  const appliedZoomRef   = useRef(1);
  const zoomAppliedRef   = useRef(false);
  const noPlateFramesRef = useRef(0);

  const [status, setStatus]             = useState<AppStatus>('idle');
  const [light, setLight]               = useState<LightState>('none');
  const [started, setStarted]           = useState(false);
  const [plateEntries, setPlateEntries] = useState<PlateEntry[]>([]);
  const [ocrStatus, setOcrStatus]       = useState<string>('');
  const [platePreviewUrl, setPlatePreviewUrl] = useState<string>(''); // OCR-tussenplaatje

  function addPlateEntry(entry: PlateEntry) {
    setPlateEntries((prev) => {
      if (prev.some((p) => p.kenteken === entry.kenteken)) return prev;
      return [entry, ...prev].slice(0, 8);
    });
  }

  function updatePlateEntry(kenteken: string, updates: Partial<PlateEntry>) {
    setPlateEntries((prev) =>
      prev.map((e) => (e.kenteken === kenteken ? { ...e, ...updates } : e)),
    );
  }

  function handleStateChange(newState: LightState) {
    setLight(newState);
    if (newState !== prevLightRef.current && audioRef.current) {
      if (newState === 'red')   playDeepBeep(audioRef.current);
      if (newState === 'green') playHighBeep(audioRef.current);
    }
    prevLightRef.current = newState;
  }

  async function applyZoom(level: number) {
    const track = videoTrackRef.current;
    if (!track) return;
    try {
      const cap = track.getCapabilities() as any;
      if (!cap?.zoom) return;
      const z = Math.max(cap.zoom.min ?? 1, Math.min(cap.zoom.max ?? 8, level));
      if (Math.abs(z - appliedZoomRef.current) < 0.15) return; // al bijna correct
      await (track.applyConstraints as any)({ advanced: [{ zoom: z }] });
      appliedZoomRef.current = z;
    } catch (_) {}
  }

  function updateZoom(bx: number, by: number, bw: number, bh: number) {
    const zc = zoomRef.current;
    const video = videoRef.current;
    if (!zc || !video) return;
    const zCtx = zc.getContext('2d');
    if (!zCtx) return;
    const pad = Math.max(6, bw * 0.15);
    const sx = Math.max(0, bx - pad);
    const sy = Math.max(0, by - pad);
    zCtx.drawImage(video, sx, sy,
      Math.min(video.videoWidth - sx, bw + pad * 2),
      Math.min(video.videoHeight - sy, bh + pad * 2),
      0, 0, zc.width, zc.height);
  }

  async function runOCR(box: PlateBox) {
    const video = videoRef.current;
    if (!video || ocrBusyRef.current) return;
    if (Date.now() < nextOCRAtRef.current) return;
    ocrBusyRef.current = true;

    const busyTimeout = setTimeout(() => { ocrBusyRef.current = false; }, 30_000);
    setOcrStatus('Scannen…');

    try {
      const preprocessed = preprocessPlate(video, box);
      setPlatePreviewUrl(preprocessed.toDataURL()); // toon wat Tesseract ziet
      const worker = await getOCRWorker();
      const { data } = await worker.recognize(preprocessed);
      const cleaned = cleanKenteken(data.text as string);

      if (cleaned && !seenPlatesRef.current.has(cleaned)) {
        seenPlatesRef.current.add(cleaned);
        setTimeout(() => seenPlatesRef.current.delete(cleaned), 300_000);
        setOcrStatus(`Kenteken: ${cleaned}`);

        // Fase 1a: directe RDW-lookup
        let result = await opzoekKentekenRdw(cleaned).catch(() => null);
        let actualKenteken = cleaned;

        // Fase 1b: RDW niet gevonden → probeer OCR-verwisselingen (S↔5, B↔8, G↔6)
        if (!result) {
          for (const alt of ocrAlternatives(cleaned)) {
            if (seenPlatesRef.current.has(alt)) continue;
            const altResult = await opzoekKentekenRdw(alt).catch(() => null);
            if (altResult) {
              result = altResult;
              actualKenteken = alt;
              seenPlatesRef.current.add(alt);
              setTimeout(() => seenPlatesRef.current.delete(alt), 300_000);
              break;
            }
          }
        }

        if (result) {
          addPlateEntry({ ...result, detectedAt: Date.now() });
        } else {
          addPlateEntry({
            kenteken: actualKenteken,
            display: displayKenteken(actualKenteken),
            merk: '', model: '',
            bouwjaar: null, catalogusprijs: null,
            vermogenKw: null, vermogenPk: null,
            accel0100: null, accelBron: null,
            detectedAt: Date.now(),
          });
        }
        setOcrStatus('');

        // Fase 2: carquery op de achtergrond (1-4s), update de al getoonde entry
        if (result?.merk) {
          opzoekCarquery(result.merk, result.model, result.bouwjaar)
            .then((accel) => {
              if (accel !== null) {
                updatePlateEntry(result!.kenteken, { accel0100: accel, accelBron: 'carquery' });
              }
            });
        }
      } else {
        nextOCRAtRef.current = Date.now() + 3_000;
        setOcrStatus(!cleaned ? 'Onduidelijk, opnieuw…' : '');
        setTimeout(() => setOcrStatus(''), 2_000);
      }
    } catch (err) {
      console.error('OCR fout:', err);
      setOcrStatus('OCR fout');
      nextOCRAtRef.current = Date.now() + 5_000;
      setTimeout(() => setOcrStatus(''), 4_000);
    } finally {
      clearTimeout(busyTimeout);
      ocrBusyRef.current = false;
      setTimeout(() => setPlatePreviewUrl(''), 4_000); // 4s zichtbaar voor debug
    }
  }

  async function runDetection() {
    if (!runningRef.current) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !modelRef.current || video.readyState < 2) {
      timerRef.current = setTimeout(runDetection, 300);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    // Lees pixels eenmalig per frame (gebruikt door zowel licht- als kentekendetectie)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // ── Stoplicht: afwisselend 1× volledig / 2× center-crop ──────────────────
    const useZoom = frameRef.current % 2 === 1;
    frameRef.current++;

    let detectCanvas: HTMLCanvasElement = canvas;
    let mapToOrig = (b: number[]) => b;

    if (useZoom) {
      if (!tempCanvasRef.current) tempCanvasRef.current = document.createElement('canvas');
      const tc = tempCanvasRef.current;
      tc.width  = canvas.width;
      tc.height = canvas.height;
      const tCtx = tc.getContext('2d');
      if (tCtx) {
        const cx = Math.floor(canvas.width  * 0.25);
        const cy = Math.floor(canvas.height * 0.25);
        const cw = Math.floor(canvas.width  * 0.50);
        const ch = Math.floor(canvas.height * 0.50);
        tCtx.drawImage(canvas, cx, cy, cw, ch, 0, 0, tc.width, tc.height);
        detectCanvas = tc;
        const sx = cw / tc.width, sy = ch / tc.height;
        mapToOrig = ([bx, by, bw, bh]) => [cx + bx * sx, cy + by * sy, bw * sx, bh * sy];
      }
    }

    try {
      const predictions: any[] = await modelRef.current.detect(detectCanvas);
      const lights = predictions.filter((p) => p.class === 'traffic light' && p.score > 0.35);

      if (lights.length === 0) {
        noneCountRef.current++;
        if (noneCountRef.current >= 4) {
          handleStateChange('none');
          const zc = zoomRef.current;
          zc?.getContext('2d')?.clearRect(0, 0, zc.width, zc.height);
        }
      } else {
        noneCountRef.current = 0;
        const best: any = lights.reduce((a: any, b: any) => (a.score > b.score ? a : b));
        const [bx, by, bw, bh] = mapToOrig(best.bbox as number[]);
        const state = detectLightColor(imageData.data, canvas.width, canvas.height, bx, by, bw, bh);
        handleStateChange(state);
        updateZoom(bx, by, bw, bh);

        const lColor = state === 'green' ? '#00ee44' : state === 'red' ? '#ff3333'
          : state === 'yellow' ? '#ffcc00' : 'rgba(255,255,255,0.6)';
        ctx.strokeStyle = lColor;
        ctx.lineWidth = Math.max(2, Math.min(6, Math.max(bw, 4) / 15));
        ctx.setLineDash([]);
        ctx.strokeRect(bx, by, bw, bh);
      }
    } catch (_) {}

    // ── Kenteken: gele rechthoeken detecteren elk frame ──────────────────────
    try {
      const plates = detectPlates(imageData.data, canvas.width, canvas.height);

      // Teken gele kaders om gevonden kentekens (gedraaid als de plaat schuin staat)
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth   = 3;
      ctx.setLineDash([8, 4]);
      for (const p of plates) {
        if (Math.abs(p.angle) > 0.04) {
          ctx.save();
          ctx.translate(p.cx, p.cy);
          ctx.rotate(p.angle);
          ctx.strokeRect(-p.pw / 2, -p.ph / 2, p.pw, p.ph);
          ctx.restore();
        } else {
          ctx.strokeRect(p.x, p.y, p.w, p.h);
        }
      }
      ctx.setLineDash([]);

      // Stabiliteitstracking per plaat-positie — OCR na 5 stabiele frames (~1.25s).
      // Meerdere platen tegelijk: elke positie-bucket heeft eigen teller.
      const nowVisible = new Set<string>();
      for (const plate of plates) {
        const key = plateBucket(plate);
        nowVisible.add(key);
        const prev = stablePlatesRef.current.get(key);
        const stable = prev &&
          Math.abs(plate.cx - prev.cx) < 120 &&
          Math.abs(plate.cy - prev.cy) < 90;

        if (stable && prev) {
          const count = prev.count + 1;
          stablePlatesRef.current.set(key, { ...plate, count });
          if (count >= 3 && !ocrBusyRef.current) {
            runOCR(plate);
          }
        } else {
          stablePlatesRef.current.set(key, { ...plate, count: 1 });
        }
      }
      // Verwijder buckets voor platen die niet meer zichtbaar zijn
      for (const key of Array.from(stablePlatesRef.current.keys())) {
        if (!nowVisible.has(key)) stablePlatesRef.current.delete(key);
      }

      // Camera-zoom: inzoomen zodra een gele plaat gevonden is.
      // Doel: plaat vult ~30% van de framebreedte zodat OCR scherp werkt.
      // Uitzoomen zodra er 5 seconden (~20 frames) geen plaat meer zichtbaar is.
      if (plates.length > 0) {
        noPlateFramesRef.current = 0;
        if (!zoomAppliedRef.current) {
          const pw = plates[0].pw;
          if (pw > 10) {
            const target = (canvas.width * 0.30) / pw;
            if (target > 1.2) {
              applyZoom(target);
              zoomAppliedRef.current = true;
            }
          }
        }
      } else {
        noPlateFramesRef.current++;
        if (noPlateFramesRef.current >= 20) {
          applyZoom(1);
          zoomAppliedRef.current = false;
          noPlateFramesRef.current = 0;
        }
      }
    } catch (_) {}

    timerRef.current = setTimeout(runDetection, 250);
  }

  async function start() {
    setStarted(true);
    setStatus('loading');
    try {
      audioRef.current = new AudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const tracks = stream.getVideoTracks();
      if (tracks.length > 0) videoTrackRef.current = tracks[0];
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const tf = await import('@tensorflow/tfjs');
      await tf.ready();
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      modelRef.current = await cocoSsd.load();
      setStatus('ready');
      runningRef.current = true;
      runDetection();
    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  }

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      audioRef.current?.close();
      videoTrackRef.current = null;
      const video = videoRef.current;
      if (video?.srcObject) (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    };
  }, []);

  const badgeClass = status === 'loading' ? styles.badgeLoading
    : status === 'ready' ? styles.badgeReady : styles.badgeError;

  const stateColor = light === 'red' ? '#ff3333' : light === 'yellow' ? '#ffcc00'
    : light === 'green' ? '#00ee44' : 'rgba(255,255,255,0.4)';

  const activePlates = plateEntries.filter((e) => Date.now() - e.detectedAt < 60_000);
  const indicatorBottom = activePlates.length > 0
    ? activePlates.length * 58 + 20
    : 44;

  return (
    <div className={styles.root}>
      <video ref={videoRef} className={styles.video} playsInline muted />
      <canvas ref={canvasRef} className={styles.canvas} />

      {(light === 'red' || light === 'green') && (
        <div
          className={light === 'green' ? styles.borderFlash : styles.borderStatic}
          style={{ borderColor: stateColor, boxShadow: `inset 0 0 60px ${stateColor}33` }}
        />
      )}

      <div className={styles.header}>
        <span className={styles.version}>v{VERSION}</span>
        {started && (
          <span className={badgeClass}>
            {status === 'loading' && 'Laden…'}
            {status === 'ready' && '● Actief'}
            {status === 'error' && '✕ Fout'}
          </span>
        )}
      </div>

      {started && status === 'ready' && light !== 'none' && (
        <canvas ref={zoomRef} width={80} height={160}
          className={styles.zoomInset} style={{ borderColor: stateColor }} />
      )}
      {started && status === 'ready' && light === 'none' && (
        <canvas ref={zoomRef} style={{ display: 'none' }} />
      )}

      {started && status === 'ready' && (
        <div className={styles.indicator}
          style={{ borderColor: `${stateColor}66`, bottom: indicatorBottom }}>
          <div className={styles.dot} style={{
            background: stateColor,
            boxShadow: light !== 'none' && light !== 'unknown' ? `0 0 10px ${stateColor}` : 'none',
          }} />
          <span className={styles.stateText} style={{ color: stateColor }}>
            {light === 'none'    && <span style={{ color: 'rgba(255,255,255,0.5)' }}>Zoeken…</span>}
            {light === 'unknown' && <span style={{ color: 'rgba(255,255,255,0.6)' }}>Stoplicht gevonden</span>}
            {light === 'red'     && 'Rood'}
            {light === 'yellow'  && 'Oranje'}
            {light === 'green'   && 'Groen'}
          </span>
        </div>
      )}

      {/* OCR tussenplaatje: toont exact wat Tesseract ziet (B&W drempel) */}
      {started && status === 'ready' && platePreviewUrl && (
        <img src={platePreviewUrl} className={styles.platePreview} alt="" />
      )}

      {/* OCR scan-status: tijdelijk zichtbaar boven de kentekenbalk */}
      {started && status === 'ready' && ocrStatus !== '' && (
        <div className={styles.ocrBadge}>{ocrStatus}</div>
      )}

      {/* Kenteken-balk: onderin, stapelt omhoog */}
      {started && status === 'ready' && (
        <PlateBar entries={plateEntries} />
      )}

      {!started && (
        <div className={styles.splash}>
          <h1 className={styles.splashTitle}>Stoplicht</h1>
          <p className={styles.splashSub}>
            Detecteert stoplichten én kentekens. Diepe toon bij rood, hoge piep bij groen.
          </p>
          <button className={styles.startButton} onClick={start}>Start</button>
          <span className={styles.splashVersion}>v{VERSION}</span>
        </div>
      )}
    </div>
  );
}
