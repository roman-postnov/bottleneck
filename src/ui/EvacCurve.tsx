// Share evacuated against time -- the chart that carries T50 / T90 / T100 (§11).
// Canvas rather than SVG: the curve grows by a point a simulated minute and is redrawn
// whole on every update.

import { useEffect, useRef } from 'react';
import { useStore } from '../main/state.ts';

const PAD = { l: 34, r: 8, t: 8, b: 18 };

export function EvacCurve(): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const curve = useStore((s) => s.curve);
  const metrics = useStore((s) => s.metrics);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const plotW = w - PAD.l - PAD.r;
    const plotH = h - PAD.t - PAD.b;
    let tMax = 3600;
    for (let i = 0; i < curve.length; i += 2) tMax = Math.max(tMax, curve[i]);
    tMax = Math.ceil(tMax / 3600) * 3600;

    g.strokeStyle = '#2a3038';
    g.fillStyle = '#7c8794';
    g.font = '10px ui-monospace, monospace';
    g.lineWidth = 1;
    for (const [pct, label] of [[0, '0%'], [0.5, '50%'], [0.9, '90%'], [1, '']] as const) {
      const y = PAD.t + plotH * (1 - pct);
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(w - PAD.r, y);
      g.stroke();
      if (label) g.fillText(label, 4, y + 3);
    }
    for (let hr = 0; hr <= tMax / 3600; hr++) {
      const x = PAD.l + (plotW * hr) / (tMax / 3600);
      g.fillText(`${hr}h`, x - 4, h - 5);
    }

    if (curve.length >= 4) {
      g.strokeStyle = '#4ea8de';
      g.lineWidth = 1.8;
      g.beginPath();
      for (let i = 0; i < curve.length; i += 2) {
        const x = PAD.l + (plotW * curve[i]) / tMax;
        const y = PAD.t + plotH * (1 - curve[i + 1]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }

    if (metrics?.t90Sec != null) {
      const x = PAD.l + (plotW * metrics.t90Sec) / tMax;
      g.strokeStyle = '#e8c33a';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, PAD.t);
      g.lineTo(x, PAD.t + plotH);
      g.stroke();
      g.setLineDash([]);
    }
  }, [curve, metrics]);

  return <canvas className="curve" ref={ref} />;
}
