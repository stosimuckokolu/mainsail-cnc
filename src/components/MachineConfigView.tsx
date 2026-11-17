import React, { useState } from 'react';
import { ConnectionMode, KlipperTelemetry, MachineConfig } from '../types/cnc';
import { Check, Copy, Link2, Save } from 'lucide-react';

interface MachineConfigViewProps {
  config: MachineConfig;
  telemetry: KlipperTelemetry;
  onSaveConfig: (next: MachineConfig) => void;
  onSwitchMode: (mode: ConnectionMode) => void;
  onConnectMoonraker: (url: string) => void;
}

const KLIPPER_CNC_CFG_SNIPPET = `# SCM Tech 99L Klipper Retrofit — Quadrant 4 Bounds & Boring Block
[stepper_x]
position_min: -500
position_endstop: 0
position_max: 3000

[stepper_y]
position_min: -1000
position_endstop: 0
position_max: 500

[stepper_z]
position_min: -10
position_endstop: 180
position_max: 180

[pwm_tool spindle]
pin: PA8
pwm: True
hardware_pwm: True
cycle_time: 0.001
shutdown_value: 0
scale: 24000

[gcode_macro M3]
gcode:
  {% set S = params.S|default(14000)|float %}
  SET_PIN PIN=spindle VALUE={S}

[gcode_macro M5]
gcode:
  SET_PIN PIN=spindle VALUE=0`;

export const MachineConfigView: React.FC<MachineConfigViewProps> = ({
  config,
  telemetry,
  onSaveConfig,
  onSwitchMode,
  onConnectMoonraker,
}) => {
  const [draft, setDraft] = useState<MachineConfig>(config);
  const [copied, setCopied] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig(draft);
  };

  const copySnippet = () => {
    navigator.clipboard.writeText(KLIPPER_CNC_CFG_SNIPPET).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <form
        onSubmit={handleSave}
        className="lg:col-span-7 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              SCM Tech 99L Klipper Host & Quadrant 4 Envelope
            </h2>
            <p className="text-xs text-slate-400">
              Configure Moonraker WebSocket connection, signed travel limits, and panel dimensions
            </p>
          </div>
          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            Save Settings
          </button>
        </div>

        <div className="border border-slate-800 rounded-md p-4 bg-[#10131b] flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-200">Telemetry Source</span>
            <div className="flex items-center gap-1 bg-[#151922] border border-slate-800 rounded-md p-1">
              <button
                type="button"
                onClick={() => onSwitchMode('emulator')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  telemetry.connectionMode === 'emulator'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Local Klipper Bench
              </button>
              <button
                type="button"
                onClick={() => onSwitchMode('moonraker')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  telemetry.connectionMode === 'moonraker'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live Moonraker Host
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={draft.moonrakerUrl}
              onChange={(e) => setDraft({ ...draft, moonrakerUrl: e.target.value })}
              placeholder="http://mainsailos.local:7125"
              className="flex-1 bg-[#0c0f14] border border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => {
                onSaveConfig(draft);
                onConnectMoonraker(draft.moonrakerUrl);
              }}
              className="px-4 py-2 text-xs font-semibold text-slate-100 bg-[#1a202c] hover:bg-slate-700 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Link2 className="w-3.5 h-3.5 text-sky-400" />
              Connect WebSocket
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Status: <span className="font-mono text-slate-200">{telemetry.statusMessage}</span>
          </p>
        </div>

        {/* Signed Axis Bounds (Quadrant 4 SCM Tech 99L) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">X Min (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.min.x}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    min: { ...draft.axisBounds.min, x: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Y Min / Front (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.min.y}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    min: { ...draft.axisBounds.min, y: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Z Min (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.min.z}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    min: { ...draft.axisBounds.min, z: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">X Max (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.max.x}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    max: { ...draft.axisBounds.max, x: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Y Max / Rear (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.max.y}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    max: { ...draft.axisBounds.max, y: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Z Max (mm)</span>
            <input
              type="number"
              value={draft.axisBounds.max.z}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  axisBounds: {
                    ...draft.axisBounds,
                    max: { ...draft.axisBounds.max, z: Number(e.target.value) },
                  },
                })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
        </div>

        {/* Panel Size (Q4) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Panel Width +X (mm)</span>
            <input
              type="number"
              min={50}
              max={3000}
              value={draft.stockSize.x}
              onChange={(e) =>
                setDraft({ ...draft, stockSize: { ...draft.stockSize, x: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Panel Depth -Y (mm)</span>
            <input
              type="number"
              min={50}
              max={1000}
              value={draft.stockSize.y}
              onChange={(e) =>
                setDraft({ ...draft, stockSize: { ...draft.stockSize, y: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Panel Thickness Z (mm)</span>
            <input
              type="number"
              min={1}
              max={180}
              value={draft.stockSize.z}
              onChange={(e) =>
                setDraft({ ...draft, stockSize: { ...draft.stockSize, z: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Spindle Max RPM</span>
            <input
              type="number"
              min={1000}
              max={40000}
              step={500}
              value={draft.spindleMaxRpm}
              onChange={(e) => setDraft({ ...draft, spindleMaxRpm: Number(e.target.value) })}
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Klipper Spindle Object</span>
            <input
              type="text"
              value={draft.spindleOutputPin}
              onChange={(e) => setDraft({ ...draft, spindleOutputPin: e.target.value })}
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Z Probe Plate (mm)</span>
            <input
              type="number"
              step={0.1}
              min={0}
              max={50}
              value={draft.probePlateThickness}
              onChange={(e) =>
                setDraft({ ...draft, probePlateThickness: Number(e.target.value) })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
        </div>
      </form>

      <section className="lg:col-span-5 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              SCM Tech 99L Klipper printer.cfg
            </h2>
            <p className="text-xs text-slate-400">
              Quadrant 4 travel limits (-500..3000, -1000..500, -10..180) and spindle macros
            </p>
          </div>
          <button
            type="button"
            onClick={copySnippet}
            className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <pre className="bg-[#0c0f14] border border-slate-800 rounded-md p-3.5 text-xs font-mono text-slate-300 overflow-x-auto leading-5">
          {KLIPPER_CNC_CFG_SNIPPET}
        </pre>
      </section>
    </div>
  );
};
