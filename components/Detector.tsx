'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Detector.module.css';

type LightState = 'none' | 'red' | 'yellow' | 'green' | 'unknown';
type AppStatus = 'idle' | 'loading' | 'ready' | 'error';

function playBeep(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.7, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.6);
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

// Deelt de bounding box op in 3 secties (rood boven, geel midden, groen onder)
// en kijkt welke sectie het helderste gekleurde licht heeft.
function detectLightColor(
  data: Uint8ClampedArray,
  imgW: number,
  x: number, y: number, w: number, h: number,
): LightState {
  const sectionH = h / 3;
  const scores = [0, 0, 0];
  const counts = [0, 0, 0];

  for (let section = 0; section < 3; section++) {
    const y0 = Math.floor(y + section * sectionH);
    const y1 = Math.floor(y0 + sectionH);
    for (let py = Math.max(0, y0); py < y1; py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.floor(x + w); px++) {
        const i = (py * imgW + px) * 4;
        const [, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        // Gewogen helderheid: hoge saturatie + hoge value = helder gekleurd licht
        scores[section] += s * v;
        counts[section]++;
      }
    }
  }

  const avg = scores.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
  const maxVal = Math.max(...avg);

  // Drempelwaarde: te laag = geen helder licht zichtbaar
  if (maxVal < 0.12) return 'unknown';

  const maxIdx = avg.indexOf(maxVal);
  return (['red', 'yellow', 'green'] as LightState[])[maxIdx];
}

export default function Detector() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<any>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const lastBeepRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const [status, setStatus] = useState<AppStatus>('idle');
  const [light, setLight] = useState<LightState>('none');
  const [started, setStarted] = useState(false);

  async function runDetection() {
    if (!runningRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !modelRef.current || video.readyState < 2) {
      timerRef.current = setTimeout(runDetection, 300);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    try {
      const predictions: any[] = await modelRef.current.detect(canvas);
      const trafficLights = predictions.filter(
        (p) => p.class === 'traffic light' && p.score > 0.45,
      );

      if (trafficLights.length === 0) {
        setLight('none');
      } else {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let state: LightState = 'unknown';

        for (const tl of trafficLights) {
          const [bx, by, bw, bh] = tl.bbox as number[];
          const detected = detectLightColor(imageData.data, canvas.width, bx, by, bw, bh);
          if (detected !== 'unknown') {
            state = detected;
            break;
          }
        }

        setLight(state);

        if (state === 'green' && audioRef.current) {
          const now = Date.now();
          if (now - lastBeepRef.current > 4000) {
            lastBeepRef.current = now;
            playBeep(audioRef.current);
          }
        }

        // Teken bounding boxes op canvas
        ctx.lineWidth = 3;
        for (const tl of trafficLights) {
          const [bx, by, bw, bh] = tl.bbox as number[];
          ctx.strokeStyle =
            state === 'green' ? '#00ee44' : state === 'red' ? '#ff3333' : '#ffcc00';
          ctx.strokeRect(bx, by, bw, bh);
        }
      }
    } catch (_) {
      // stille fout, volgende frame proberen
    }

    timerRef.current = setTimeout(runDetection, 250);
  }

  async function start() {
    setStarted(true);
    setStatus('loading');

    try {
      // AudioContext vereist een gebruikersactie — hier aangemaakt na klik
      audioRef.current = new AudioContext();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Dynamische import zodat TF.js niet de initiële pagina vertraagt
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
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const dotClass =
    light === 'red' ? styles.dotRed
    : light === 'yellow' ? styles.dotYellow
    : light === 'green' ? styles.dotGreen
    : light === 'unknown' ? styles.dotUnknown
    : styles.dot;

  const badgeClass =
    status === 'loading' ? styles.badgeLoading
    : status === 'ready' ? styles.badgeReady
    : styles.badgeError;

  return (
    <div className={styles.root}>
      <video ref={videoRef} className={styles.video} playsInline muted />
      <canvas ref={canvasRef} className={styles.canvas} />

      {light === 'green' && <div className={styles.greenFlash} />}

      <div className={styles.header}>
        <span className={styles.title}>Stoplicht</span>
        {started && (
          <span className={badgeClass}>
            {status === 'loading' && 'Laden…'}
            {status === 'ready' && '● Actief'}
            {status === 'error' && '✕ Fout'}
          </span>
        )}
      </div>

      {started && status === 'ready' && (
        <div className={styles.indicator}>
          <div className={`${styles.dot} ${dotClass}`} />
          <span>
            {light === 'none' && 'Zoeken naar stoplicht…'}
            {light === 'unknown' && 'Stoplicht gevonden'}
            {light === 'red' && 'Rood'}
            {light === 'yellow' && 'Oranje'}
            {light === 'green' && 'GROEN — piep!'}
          </span>
        </div>
      )}

      {!started && (
        <div className={styles.splash}>
          <h1 className={styles.splashTitle}>Stoplicht</h1>
          <p className={styles.splashSub}>
            Richt de camera op een stoplicht. Je krijgt een piep zodra het groen wordt.
          </p>
          <button className={styles.startButton} onClick={start}>
            Start
          </button>
        </div>
      )}
    </div>
  );
}
