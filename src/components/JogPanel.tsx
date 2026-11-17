import React, { useState } from 'react';
import { KlipperTelemetry } from '../types/cnc';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Crosshair,
  Home,
  LocateFixed,
} from 'lucide-react';

interface JogPanelProps {
  telemetry: KlipperTelemetry;
  onJog: (axis: 'X' | 'Y' | 'Z', deltaMm: number) => void;
  onHome: (axes: 'all' | 'X' | 'Y' | 'Z') => void;
  onProbeZ: () => void;
  onGoToWorkZero: () => void;
}

const STEP_SIZES = [0.1, 1, 10, 50];

export const JogPanel: React.FC<JogPanelProps> = ({
  telemetry,
  onJog,
  onHome,
  onProbeZ,
  onGoToWorkZero,
}) => {
  const [step, setStep] = useState<number>(10);
  const disabled = telemetry.isJobRunning || telemetry.machineState === 'estop';

  return (
    <section className="bg-[#151922] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">Jog & Homing</h2>
        <div className="flex items-center gap-1 bg-[#0e1117] border border-slate-800 rounded-md p-0.5">
          {STEP_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStep(s)}
              className={`px-2 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                step === s
                  ? 'bg-sky-500/20 text-sky-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {s}
            </button>
          ))}
          <span className="px-1.5 text-[10px] font-mono text-slate-500">mm</span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
        {/* XY Pad */}
        <div className="grid grid-cols-3 gap-1.5 max-w-[192px]">
          <button
            type="button"
            onClick={() => onHome('all')}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-slate-700/70 disabled:opacity-40 border border-slate-700/80 text-slate-200 text-xs font-medium flex items-center justify-center gap-1 transition-colors"
            title="Home All Axes (G28)"
          >
            <Home className="w-3.5 h-3.5 text-sky-400" />
            <span>G28</span>
          </button>
          <button
            type="button"
            onClick={() => onJog('Y', step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-slate-100 flex items-center justify-center transition-colors"
            title={`Y +${step} mm`}
          >
            <ArrowUp className="w-4 h-4 text-emerald-400" />
          </button>
          <button
            type="button"
            onClick={onProbeZ}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-slate-700/70 disabled:opacity-40 border border-slate-700/80 text-slate-200 text-xs font-medium flex items-center justify-center gap-1 transition-colors"
            title="Probe Z Touchplate"
          >
            <LocateFixed className="w-3.5 h-3.5 text-amber-400" />
            <span>Probe</span>
          </button>

          <button
            type="button"
            onClick={() => onJog('X', -step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-slate-100 flex items-center justify-center transition-colors"
            title={`X -${step} mm`}
          >
            <ArrowLeft className="w-4 h-4 text-rose-400" />
          </button>
          <button
            type="button"
            onClick={onGoToWorkZero}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-sky-300 text-xs font-mono font-semibold flex items-center justify-center transition-colors"
            title="Move to Work Zero (G0 X0 Y0)"
          >
            <Crosshair className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onJog('X', step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-slate-100 flex items-center justify-center transition-colors"
            title={`X +${step} mm`}
          >
            <ArrowRight className="w-4 h-4 text-rose-400" />
          </button>

          <button
            type="button"
            onClick={() => onHome('X')}
            disabled={disabled}
            className="h-10 rounded bg-[#12161f] hover:bg-slate-800 disabled:opacity-40 border border-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono flex items-center justify-center transition-colors"
          >
            H-X
          </button>
          <button
            type="button"
            onClick={() => onJog('Y', -step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-slate-100 flex items-center justify-center transition-colors"
            title={`Y -${step} mm`}
          >
            <ArrowDown className="w-4 h-4 text-emerald-400" />
          </button>
          <button
            type="button"
            onClick={() => onHome('Y')}
            disabled={disabled}
            className="h-10 rounded bg-[#12161f] hover:bg-slate-800 disabled:opacity-40 border border-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono flex items-center justify-center transition-colors"
          >
            H-Y
          </button>
        </div>

        {/* Z Column */}
        <div className="flex flex-col gap-1.5 w-20">
          <button
            type="button"
            onClick={() => onJog('Z', step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-sky-300 text-xs font-mono font-semibold flex items-center justify-center gap-1 transition-colors"
            title={`Z +${step} mm`}
          >
            <ArrowUp className="w-3.5 h-3.5" />
            <span>Z+</span>
          </button>
          <button
            type="button"
            onClick={() => onHome('Z')}
            disabled={disabled}
            className="h-10 rounded bg-[#12161f] hover:bg-slate-800 disabled:opacity-40 border border-slate-800 text-slate-300 text-xs font-mono flex items-center justify-center transition-colors"
            title="Home Z (G28 Z)"
          >
            H-Z
          </button>
          <button
            type="button"
            onClick={() => onJog('Z', -step)}
            disabled={disabled}
            className="h-10 rounded bg-[#1a202c] hover:bg-sky-500/20 hover:border-sky-500/40 disabled:opacity-40 border border-slate-700/80 text-sky-300 text-xs font-mono font-semibold flex items-center justify-center gap-1 transition-colors"
            title={`Z -${step} mm`}
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Z-</span>
          </button>
        </div>
      </div>
    </section>
  );
};
