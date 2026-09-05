import { canvas, ctx } from '../dom.js';
import { state } from '../state.js';
import { screenToWorld, worldToScreen } from './viewport.js';

export const IMPERIAL_GRID_LADDER = [
  1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 3, 6,
];

export function decadeStep(target) {
  const power = Math.pow(10, Math.floor(Math.log10(target)));
  const norm = target / power;
  return (norm < 2 ? 2 : norm < 5 ? 5 : 10) * power;
}

export function chooseGridStep(target, settings = state.unitSettings) {
  if (!Number.isFinite(target) || target <= 0) return 1;
  const imperial = settings.drawingUnit === 'inches' &&
    ['architectural', 'engineering', 'fractional'].includes(settings.format);
  if (!imperial) return decadeStep(target);
  for (const candidate of IMPERIAL_GRID_LADDER) {
    if (target <= candidate) return candidate;
  }
  return decadeStep(target / 12) * 12;
}

export function drawGrid() {
  const scale = state.view.scale;
  const desiredPx = 60;
  const step = chooseGridStep(desiredPx / scale);

  const topLeft = screenToWorld({x:0,y:0});
  const bottomRight = screenToWorld({x:canvas.clientWidth,y:canvas.clientHeight});
  const minX = Math.floor(topLeft.x/step)*step;
  const maxX = Math.ceil(bottomRight.x/step)*step;
  const minY = Math.floor(bottomRight.y/step)*step;
  const maxY = Math.ceil(topLeft.y/step)*step;

  // Defensive: never try to stroke thousands of lines if the step collapses.
  const lineBudget = 400;
  const tooDense = (maxX - minX) / step > lineBudget || (maxY - minY) / step > lineBudget;

  ctx.lineWidth = 1;
  if (tooDense) {
    const origin = worldToScreen({x:0,y:0});
    ctx.strokeStyle = '#343434';
    ctx.beginPath();
    ctx.moveTo(origin.x,0); ctx.lineTo(origin.x,canvas.clientHeight);
    ctx.moveTo(0,origin.y); ctx.lineTo(canvas.clientWidth,origin.y);
    ctx.stroke();
    return;
  }
  ctx.strokeStyle = '#202020';
  ctx.beginPath();
  for (let x=minX; x<=maxX; x+=step) {
    const s = worldToScreen({x,y:0});
    ctx.moveTo(s.x,0); ctx.lineTo(s.x,canvas.clientHeight);
  }
  for (let y=minY; y<=maxY; y+=step) {
    const s = worldToScreen({x:0,y});
    ctx.moveTo(0,s.y); ctx.lineTo(canvas.clientWidth,s.y);
  }
  ctx.stroke();

  const origin = worldToScreen({x:0,y:0});
  ctx.strokeStyle = '#343434';
  ctx.beginPath();
  ctx.moveTo(origin.x,0); ctx.lineTo(origin.x,canvas.clientHeight);
  ctx.moveTo(0,origin.y); ctx.lineTo(canvas.clientWidth,origin.y);
  ctx.stroke();
}
