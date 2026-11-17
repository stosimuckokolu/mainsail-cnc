import { MoveType, ParsedGCode, ToolpathSegment, Vec3 } from '../types/cnc';

interface ParserState {
  pos: Vec3;
  absolute: boolean;
  unitsScale: number; // 1 for mm (G21), 25.4 for inches (G20)
  motionMode: 0 | 1 | 2 | 3; // G0, G1, G2, G3
  plane: 17 | 18 | 19; // G17 XY, G18 XZ, G19 YZ
  feedrate: number;
  spindleRpm: number;
}

const ARC_STEP_MM = 0.6;

function stripComments(rawLine: string): string {
  // Remove (...) comments and ; ... comments
  return rawLine
    .replace(/\([^)]*\)/g, '')
    .replace(/;.*$/, '')
    .trim();
}

function parseWords(cleanLine: string): Array<{ letter: string; value: number }> {
  const words: Array<{ letter: string; value: number }> = [];
  const regex = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanLine)) !== null) {
    words.push({
      letter: match[1].toUpperCase(),
      value: parseFloat(match[2]),
    });
  }
  return words;
}

function subdivideArc(
  start: Vec3,
  end: Vec3,
  clockwise: boolean,
  plane: 17 | 18 | 19,
  iVal: number | undefined,
  jVal: number | undefined,
  kVal: number | undefined,
  rVal: number | undefined,
): Vec3[] {
  // Select plane axes: u (horizontal), v (vertical), w (helical)
  const getUV = (p: Vec3): [number, number, number] => {
    if (plane === 17) return [p.x, p.y, p.z];
    if (plane === 18) return [p.z, p.x, p.y];
    return [p.y, p.z, p.x];
  };
  const fromUV = (u: number, v: number, w: number): Vec3 => {
    if (plane === 17) return { x: u, y: v, z: w };
    if (plane === 18) return { x: v, y: w, z: u };
    return { x: w, y: u, z: v };
  };

  const [su, sv, sw] = getUV(start);
  const [eu, ev, ew] = getUV(end);

  let cu = su;
  let cv = sv;

  if (iVal !== undefined || jVal !== undefined || kVal !== undefined) {
    if (plane === 17) {
      cu = su + (iVal ?? 0);
      cv = sv + (jVal ?? 0);
    } else if (plane === 18) {
      cu = su + (kVal ?? 0);
      cv = sv + (iVal ?? 0);
    } else {
      cu = su + (jVal ?? 0);
      cv = sv + (kVal ?? 0);
    }
  } else if (rVal !== undefined && rVal !== 0) {
    const du = eu - su;
    const dv = ev - sv;
    const chord = Math.hypot(du, dv);
    if (chord < 1e-6) {
      return [end];
    }
    const r = Math.abs(rVal);
    const halfChord = Math.min(r, chord / 2);
    const h = Math.sqrt(Math.max(0, r * r - halfChord * halfChord));
    const mu = (su + eu) / 2;
    const mv = (sv + ev) / 2;
    const nu = -dv / chord;
    const nv = du / chord;
    // Pick center based on CW/CCW and sign of R
    const sign = (clockwise ? -1 : 1) * (rVal > 0 ? 1 : -1);
    cu = mu + sign * h * nu;
    cv = mv + sign * h * nv;
  } else {
    return [end];
  }

  const radius = Math.hypot(su - cu, sv - cv);
  if (radius < 1e-5) {
    return [end];
  }

  const startAngle = Math.atan2(sv - cv, su - cu);
  const endAngle = Math.atan2(ev - cv, eu - cu);
  let sweep = endAngle - startAngle;

  if (clockwise) {
    if (sweep >= 0) sweep -= Math.PI * 2;
    // Full circle if start == end
    if (Math.hypot(eu - su, ev - sv) < 1e-4) sweep = -Math.PI * 2;
  } else {
    if (sweep <= 0) sweep += Math.PI * 2;
    if (Math.hypot(eu - su, ev - sv) < 1e-4) sweep = Math.PI * 2;
  }

  const arcLen = Math.abs(sweep) * radius;
  const steps = Math.max(6, Math.min(180, Math.ceil(arcLen / ARC_STEP_MM)));
  const points: Vec3[] = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const ang = startAngle + sweep * t;
    const u = cu + radius * Math.cos(ang);
    const v = cv + radius * Math.sin(ang);
    const w = sw + (ew - sw) * t;
    points.push(fromUV(u, v, w));
  }
  // Snap last point exactly to target
  points[points.length - 1] = { ...end };
  return points;
}

export function parseGCode(
  source: string,
  defaultRapidFeed = 3000,
  defaultCutFeed = 800,
): ParsedGCode {
  const lines = source.split(/\r?\n/);
  const segments: ToolpathSegment[] = [];

  const state: ParserState = {
    pos: { x: 0, y: 0, z: 10 },
    absolute: true,
    unitsScale: 1,
    motionMode: 0,
    plane: 17,
    feedrate: defaultCutFeed,
    spindleRpm: 0,
  };

  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  let totalLengthMm = 0;
  let cutLengthMm = 0;
  let rapidLengthMm = 0;
  let estimatedTimeSec = 0;

  const updateBounds = (p: Vec3) => {
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const clean = stripComments(lines[idx]);
    if (!clean) continue;

    const words = parseWords(clean);
    if (words.length === 0) continue;

    let hasMotionCoords = false;
    let targetX: number | undefined;
    let targetY: number | undefined;
    let targetZ: number | undefined;
    let iVal: number | undefined;
    let jVal: number | undefined;
    let kVal: number | undefined;
    let rVal: number | undefined;
    let isHomeCmd = false;
    let homeAxes = { x: false, y: false, z: false };

    for (const { letter, value } of words) {
      switch (letter) {
        case 'G': {
          const code = Math.round(value);
          if (code === 0) state.motionMode = 0;
          else if (code === 1) state.motionMode = 1;
          else if (code === 2) state.motionMode = 2;
          else if (code === 3) state.motionMode = 3;
          else if (code === 17) state.plane = 17;
          else if (code === 18) state.plane = 18;
          else if (code === 19) state.plane = 19;
          else if (code === 20) state.unitsScale = 25.4;
          else if (code === 21) state.unitsScale = 1;
          else if (code === 28) isHomeCmd = true;
          else if (code === 90) state.absolute = true;
          else if (code === 91) state.absolute = false;
          break;
        }
        case 'M': {
          const code = Math.round(value);
          if (code === 3 || code === 4) {
            if (state.spindleRpm === 0) state.spindleRpm = 12000;
          } else if (code === 5) {
            state.spindleRpm = 0;
          }
          break;
        }
        case 'S':
          state.spindleRpm = Math.max(0, value);
          break;
        case 'F':
          if (value > 0) state.feedrate = value * state.unitsScale;
          break;
        case 'X':
          if (isHomeCmd) homeAxes.x = true;
          else {
            targetX = value * state.unitsScale;
            hasMotionCoords = true;
          }
          break;
        case 'Y':
          if (isHomeCmd) homeAxes.y = true;
          else {
            targetY = value * state.unitsScale;
            hasMotionCoords = true;
          }
          break;
        case 'Z':
          if (isHomeCmd) homeAxes.z = true;
          else {
            targetZ = value * state.unitsScale;
            hasMotionCoords = true;
          }
          break;
        case 'I':
          iVal = value * state.unitsScale;
          break;
        case 'J':
          jVal = value * state.unitsScale;
          break;
        case 'K':
          kVal = value * state.unitsScale;
          break;
        case 'R':
          rVal = value * state.unitsScale;
          break;
      }
    }

    if (isHomeCmd) {
      const homeAll = !homeAxes.x && !homeAxes.y && !homeAxes.z;
      const next: Vec3 = {
        x: homeAll || homeAxes.x ? 0 : state.pos.x,
        y: homeAll || homeAxes.y ? 0 : state.pos.y,
        z: homeAll || homeAxes.z ? 25 : state.pos.z,
      };
      const dist = Math.hypot(
        next.x - state.pos.x,
        next.y - state.pos.y,
        next.z - state.pos.z,
      );
      if (dist > 1e-4) {
        segments.push({
          start: { ...state.pos },
          end: next,
          type: 'rapid',
          feedrate: defaultRapidFeed,
          lineNumber: idx,
          spindleRpm: state.spindleRpm,
        });
        rapidLengthMm += dist;
        totalLengthMm += dist;
        estimatedTimeSec += (dist / defaultRapidFeed) * 60;
      }
      state.pos = next;
      continue;
    }

    if (!hasMotionCoords && iVal === undefined && jVal === undefined && kVal === undefined) {
      continue;
    }

    const endPos: Vec3 = state.absolute
      ? {
          x: targetX !== undefined ? targetX : state.pos.x,
          y: targetY !== undefined ? targetY : state.pos.y,
          z: targetZ !== undefined ? targetZ : state.pos.z,
        }
      : {
          x: state.pos.x + (targetX ?? 0),
          y: state.pos.y + (targetY ?? 0),
          z: state.pos.z + (targetZ ?? 0),
        };

    if (state.motionMode === 2 || state.motionMode === 3) {
      const arcPoints = subdivideArc(
        state.pos,
        endPos,
        state.motionMode === 2,
        state.plane,
        iVal,
        jVal,
        kVal,
        rVal,
      );
      let prev = { ...state.pos };
      for (const pt of arcPoints) {
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y, pt.z - prev.z);
        if (dist > 1e-5) {
          segments.push({
            start: prev,
            end: pt,
            type: 'arc',
            feedrate: state.feedrate,
            lineNumber: idx,
            spindleRpm: state.spindleRpm,
          });
          updateBounds(prev);
          updateBounds(pt);
          cutLengthMm += dist;
          totalLengthMm += dist;
          estimatedTimeSec += (dist / Math.max(1, state.feedrate)) * 60;
          prev = pt;
        }
      }
      state.pos = endPos;
    } else {
      const dist = Math.hypot(
        endPos.x - state.pos.x,
        endPos.y - state.pos.y,
        endPos.z - state.pos.z,
      );
      if (dist > 1e-5) {
        let moveType: MoveType = state.motionMode === 0 ? 'rapid' : 'cut';
        if (
          moveType === 'cut' &&
          endPos.z < state.pos.z &&
          Math.hypot(endPos.x - state.pos.x, endPos.y - state.pos.y) < 0.05
        ) {
          moveType = 'plunge';
        }
        const feed = moveType === 'rapid' ? defaultRapidFeed : state.feedrate;
        segments.push({
          start: { ...state.pos },
          end: { ...endPos },
          type: moveType,
          feedrate: feed,
          lineNumber: idx,
          spindleRpm: state.spindleRpm,
        });
        updateBounds(state.pos);
        updateBounds(endPos);
        totalLengthMm += dist;
        if (moveType === 'rapid') rapidLengthMm += dist;
        else cutLengthMm += dist;
        estimatedTimeSec += (dist / Math.max(1, feed)) * 60;
      }
      state.pos = endPos;
    }
  }

  if (min.x === Infinity) {
    min.x = 0;
    min.y = 0;
    min.z = 0;
    max.x = 0;
    max.y = 0;
    max.z = 0;
  }

  return {
    segments,
    lines,
    bounds: { min, max },
    totalLengthMm,
    cutLengthMm,
    rapidLengthMm,
    estimatedTimeSec,
  };
}
