import React, { useEffect, useRef } from 'react';
import { KlipperTelemetry, ParsedGCode } from '../types/cnc';
import { Pause, Play, Square, Upload } from 'lucide-react';

interface JobControlPanelProps {
  telemetry: KlipperTelemetry;
  filename: string | null;
  parsedGCode: ParsedGCode | null;
  spindleMaxRpm: number;
  onStartJob: () => void;
  onPauseResume: () => void;
  onStopJob: () => void;
  onFeedOverride: (pct: number) => void;
  onSetSpindle: (rpm: number) => void;
  onUploadClick: () => void;
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export const JobControlPanel: React.FC<JobControlPanelProps> = ({
  telemetry,
  filename,
  parsedGCode,
  spindleMaxRpm,
  onStartJob,
  onPauseResume,
  onStopJob,
  onFeedOverride,
  onSetSpindle,
  onUploadClick,
}) => {
  const activeLineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeLineRef.current && telemetry.isJobRunning) {
      activeLineRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [telemetry.activeLineIndex, telemetry.isJobRunning]);

  const progressPct = Math.round(telemetry.jobProgress * 100);
  const lines = parsedGCode?.lines ?? [];
  const visibleWindowStart = Math.max(0, telemetry.activeLineIndex - 8);
  const visibleLines =
    lines.length > 180 && telemetry.activeLineIndex >= 0
      ? lines.slice(visibleWindowStart, visibleWindowStart + 80)
      : lines.slice(0, 180);
  const baseLineOffset =
    lines.length > 180 && telemetry.activeLineIndex >= 0 ? visibleWindowStart : 0;

  return (
    <section className="bg-[#151922] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">Job Execution</h2>
          <p className="text-xs text-slate-400 truncate font-mono">
            {filename ?? 'No G-code file loaded'}
          </p>
        </div>
        <button
          type="button"
          onClick={onUploadClick}
          className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700/70 border border-slate-700 rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="w-3.5 h-3.5" />
          Load File
        </button>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onStartJob}
          disabled={!parsedGCode || telemetry.isJobRunning || telemetry.machineState === 'estop'}
          className="px-3 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:pointer-events-none rounded flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          Run Job
        </button>
        <button
          type="button"
          onClick={onPauseResume}
          disabled={!telemetry.isJobRunning}
          className="px-3 py-2 text-xs font-semibold text-slate-100 bg-amber-600/80 hover:bg-amber-600 disabled:opacity-40 disabled:pointer-events-none rounded flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          {telemetry.isJobPaused ? (
            <>
              <Play className="w-3.5 h-3.5" />
              Resume
            </>
          ) : (
            <>
              <Pause className="w-3.5 h-3.5" />
              Feedhold
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onStopJob}
          disabled={!telemetry.isJobRunning}
          className="px-3 py-2 text-xs font-semibold text-slate-100 bg-rose-600/80 hover:bg-rose-600 disabled:opacity-40 disabled:pointer-events-none rounded flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Square className="w-3.5 h-3.5" />
          Stop
        </button>
      </div>

      {/* Progress & Path Stats */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs font-mono text-slate-400">
          <span>
            {progressPct}% · {formatDuration(telemetry.jobElapsedSec)} /{' '}
            {parsedGCode ? formatDuration(parsedGCode.estimatedTimeSec) : '--:--'}
          </span>
          {parsedGCode && (
            <span>
              Cut {parsedGCode.cutLengthMm.toFixed(0)} mm · Rapid{' '}
              {parsedGCode.rapidLengthMm.toFixed(0)} mm
            </span>
          )}
        </div>
        <div className="w-full h-1.5 bg-[#0e1117] rounded-full overflow-hidden border border-slate-800">
          <div
            className="h-full bg-sky-500 transition-all duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Feedrate & Spindle Overrides */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <label className="flex flex-col gap-1 text-xs">
          <div className="flex justify-between text-slate-400 font-mono">
            <span>Feed Override</span>
            <span className="text-slate-200">{telemetry.feedrateOverride}%</span>
          </div>
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            value={telemetry.feedrateOverride}
            onChange={(e) => onFeedOverride(Number(e.target.value))}
            className="accent-sky-500 cursor-pointer"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <div className="flex justify-between text-slate-400 font-mono">
            <span>Spindle RPM</span>
            <span className="text-slate-200">{Math.round(telemetry.spindleTargetRpm)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={spindleMaxRpm}
            step={500}
            value={telemetry.spindleTargetRpm}
            onChange={(e) => onSetSpindle(Number(e.target.value))}
            className="accent-emerald-500 cursor-pointer"
          />
        </label>
      </div>

      {/* Live Executing G-Code Stream */}
      <div className="border border-slate-800 rounded-md bg-[#0d1016] h-36 overflow-y-auto font-mono text-[11px] leading-5 p-2">
        {visibleLines.length === 0 ? (
          <div className="text-slate-500 italic p-2">
            Load a G-code file or send MDI commands to trace live on the CNC table.
          </div>
        ) : (
          visibleLines.map((line, i) => {
            const actualIndex = baseLineOffset + i;
            const isActive = actualIndex === telemetry.activeLineIndex;
            return (
              <div
                key={actualIndex}
                ref={isActive ? activeLineRef : undefined}
                className={`flex gap-2 px-1.5 rounded ${
                  isActive
                    ? 'bg-sky-500/20 text-sky-200 font-semibold'
                    : 'text-slate-400'
                }`}
              >
                <span className="text-slate-600 select-none w-8 text-right shrink-0">
                  {actualIndex + 1}
                </span>
                <span className="truncate">{line || ' '}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
