'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Detector.module.css';
import PlateBar, { type PlateEntry } from './PlateBar';
import { detectPlates, preprocessPlate } from '@/lib/plateDetect';
import { opzoekKenteken } from '@/lib/rdw';

const VERSION = '1.4.2';

type LightState = 'none' | 'red' | 'yellow' | 'green' | 'unknown';
type AppStatus = 'idle' | 'loading' | 'ready' | 'error';

function localDisplayKenteken(clean: string): string {
  if (clean.length === 6) return `${clean.slice(0,2)}-${clean.slice(2,4)}-${clean.slice(4,6)}`;
  if (clean.length === 7) return `${clean.slice(0,1)}-${clean.slice(1,4)}-${clean.slice(4,7)}`;
  return clean;
}

// Module-level Tesseract worker (hergebruikt over meerdere OCR-runs)
let _ocrWorker: any = null;
async function getOCRWorker() {
  if (_ocrWorker) return _ocrWorker;
  const { createWorker } = await import('tesseract.js');
  _ocrWorker = await createWorker('eng', 1, { logger: () => {} });
  await _ocrWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '7', // single text line
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

  // Kenteken-tracking
  const stablePlateRef = useRef<{ x: number; y: number; w: number; h: number; count: number } | null>(null);
  const ocrBusyRef     = useRef(false);
  const nextOCRAtRef   = useRef(0); // timestamp: wacht na mislukte scan
  const seenPlatesRef  = useRef<Set<string>>(new Set()); // 5-min cache tegen dubbele OCR

  const [status, setStatus]             = useState<AppStatus>('idle');
  const [light, setLight]               = useState<LightState>('none');
  const [started, setStarted]           = useState(false);
  const [plateEntries, setPlateEntries] = useState<PlateEntry[]>([]);
  const [ocrStatus, setOcrStatus]       = useState<string>(''); // zichtbare debug-status

  function addPlateEntry(entry: PlateEntry) {
    setPlateEntries((prev) => {
      if (prev.some((p) => p.kenteken === entry.kenteken)) return prev;
      return [entry, ...prev].slice(0, 8);
    });
  }

  function handleStateChange(newState: LightState) {
    setLight(newState);
    if (newState !== prevLightRef.current && audioRef.current) {
      if (newState === 'red')   playDeepBeep(audioRef.current);
      if (newState === 'green') playHighBeep(audioRef.current);
    }
    prevLightRef.current = newState;
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

  async function runOCR(box: { x: number; y: number; w: number; h: number }) {
    const video = videoRef.current;
    if (!video || ocrBusyRef.current) return;
    if (Date.now() < nextOCRAtRef.current) return; // wacht na mislukte scan
    ocrBusyRef.current = true;

    // Veiligheidsklep: zet ocrBusyRef vrij als het meer dan 30s duurt
    const busyTimeout = setTimeout(() => { ocrBusyRef.current = false; }, 30_000);

    setOcrStatus('Scannen…');
    try {
      const preprocessed = preprocessPlate(video, box);
      const worker = await getOCRWorker();
      const { data } = await worker.recognize(preprocessed);
      const raw = (data.text as string).replace(/[^A-Z0-9]/g, '');

      if (raw.length >= 3 && !seenPlatesRef.current.has(raw)) {
        seenPlatesRef.current.add(raw);
        setTimeout(() => seenPlatesRef.current.delete(raw), 300_000);

        setOcrStatus(`Kenteken: ${raw}`);

        // RDW opzoeken; bij mislukken toch het kenteken tonen
        const result = await opzoekKenteken(raw).catch(() => null);
        if (result) {
          addPlateEntry({ ...result, detectedAt: Date.now() });
        } else {
          addPlateEntry({
            kenteken: raw,
            display: localDisplayKenteken(raw),
            merk: '', model: '',
            bouwjaar: null, catalogusprijs: null, schatting0100: null,
            detectedAt: Date.now(),
          });
        }
        setOcrStatus('');
      } else {
        // OCR-tekst te kort of al gezien → probeer over 3s opnieuw
        nextOCRAtRef.current = Date.now() + 3_000;
        setOcrStatus(raw.length < 3 ? 'Onduidelijk, opnieuw…' : '');
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

      // Teken gele kaders om gevonden kentekens
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth   = 3;
      ctx.setLineDash([8, 4]);
      for (const p of plates) ctx.strokeRect(p.x, p.y, p.w, p.h);
      ctx.setLineDash([]);

      // Stabiliteitscheck: OCR na 5 stabiele frames (~1.25s)
      if (plates.length > 0) {
        const best = plates[0];
        const prev = stablePlateRef.current;
        const stable = prev &&
          Math.abs(best.x - prev.x) < 70 &&
          Math.abs(best.y - prev.y) < 55 &&
          Math.abs(best.w - prev.w) < 80;

        if (stable) {
          stablePlateRef.current = { ...best, count: prev.count + 1 };
          if (prev.count >= 5 && !ocrBusyRef.current) {
            runOCR(best);
          }
        } else {
          stablePlateRef.current = { ...best, count: 1 };
        }
      } else {
        stablePlateRef.current = null;
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
