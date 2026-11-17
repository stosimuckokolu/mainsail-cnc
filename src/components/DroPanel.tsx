import React from 'react';
import { KlipperTelemetry, WcsName } from '../types/cnc';
import { Power } from 'lucide-react';

interface DroPanelProps {
  telemetry: KlipperTelemetry;
  spindleMaxRpm: number;
  onZeroAxis: (axis: 'X' | 'Y' | 'Z' | 'XY' | 'ALL') => void;
  onSelectWcs: (wcs: WcsName) => void;
  onSetSpindle: (rpm: number) => void;
}

const WCS_LIST: WcsName[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];

export const DroPanel: React.FC<DroPanelProps> = ({
  telemetry,
  spindleMaxRpm,
  onZeroAxis,
  onSelectWcs,
  onSetSpindle,
}) => {
  const axes: Array<{
    key: 'X' | 'Y' | 'Z';
    work: number;
    machine: number;
    homed: boolean;
    accent: string;
  }> = [
    {
      key: 'X',
      work: telemetry.workPos.x,
      machine: telemetry.machinePos.x,
      homed: telemetry.homedAxes.x,
      accent: 'text-rose-400',
    },
    {
      key: 'Y',
      work: telemetry.workPos.y,
      machine: telemetry.machinePos.y,
      homed: telemetry.homedAxes.y,
      accent: 'text-emerald-400',
    },
    {
      key: 'Z',
      work: telemetry.workPos.z,
      machine: telemetry.machinePos.z,
      homed: telemetry.homedAxes.z,
      accent: 'text-sky-400',
    },
  ];

  const isSpindleOn = telemetry.spindleTargetRpm > 0;

  return (
    <section className="bg-[#151922] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">Digital Readout</h2>
        <div className="flex items-center gap-1 bg-[#0e1117] border border-slate-800 rounded-md p-0.5">
          {WCS_LIST.map((wcs) => (
            <button
              key={wcs}
              type="button"
              onClick={() => onSelectWcs(wcs)}
              className={`px-2 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                telemetry.activeWcs === wcs
                  ? 'bg-sky-500/20 text-sky-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {wcs}
            </button>
          ))}
        </div>
      </div>

      {/* Axis Rows */}
      <div className="divide-y divide-slate-800/80 border border-slate-800/80 rounded-md bg-[#10131b]">
        {axes.map((ax) => (
          <div
            key={ax.key}
            className="flex items-center justify-between px-3 py-2.5 gap-3"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`font-mono text-base font-bold w-5 ${ax.accent}`}>{ax.key}</span>
              <div className="flex flex-col">
                <span className="font-mono text-lg font-semibold text-slate-100 leading-tight">
                  {ax.work >= 0 ? ' ' : ''}
                  {ax.work.toFixed(3)}
                </span>
                <span className="font-mono text-[11px] text-slate-500">
                  MCS {ax.machine.toFixed(2)} mm · {ax.homed ? 'Homed' : 'Unhomed'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onZeroAxis(ax.key)}
              disabled={telemetry.isJobRunning}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-[#1a202c] hover:bg-slate-700/70 disabled:opacity-40 disabled:pointer-events-none border border-slate-700/80 rounded transition-colors whitespace-nowrap shrink-0"
              title={`Set ${telemetry.activeWcs} ${ax.key} = 0`}
            >
              Zero {ax.key}
            </button>
          </div>
        ))}
      </div>

      {/* Quick Zero & Live Motion Readout */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onZeroAxis('XY')}
            disabled={telemetry.isJobRunning}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700/70 disabled:opacity-40 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            Zero XY
          </button>
          <button
            type="button"
            onClick={() => onZeroAxis('ALL')}
            disabled={telemetry.isJobRunning}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700/70 disabled:opacity-40 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            Zero XYZ
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono text-slate-300">
          <span>
            F <strong className="text-slate-100">{Math.round(telemetry.liveVelocity)}</strong> mm/m
          </span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() =>
              onSetSpindle(isSpindleOn ? 0 : Math.min(spindleMaxRpm, 12000))
            }
            className={`px-2.5 py-1 rounded border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              isSpindleOn
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-[#1a202c] border-slate-700 text-slate-300 hover:text-white'
            }`}
            title="Toggle Spindle (M3 / M5)"
          >
            <Power className="w-3 h-3" />
            <span>{Math.round(telemetry.spindleRpm)} RPM</span>
          </button>
        </div>
      </div>
    </section>
  );
};
