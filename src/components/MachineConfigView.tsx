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

const KLIPPER_CNC_CFG_SNIPPET = `# Klipper CNC Spindle & G-Code Macro Reference (printer.cfg)
[pwm_tool spindle]
pin: PA8
pwm: True
hardware_pwm: True
cycle_time: 0.001
maximum_mcu_duration: 5
shutdown_value: 0
scale: 24000

[gcode_macro M3]
description: Start spindle CW (M3 S<rpm>)
gcode:
  {% set S = params.S|default(12000)|float %}
  SET_PIN PIN=spindle VALUE={S}

[gcode_macro M5]
description: Stop spindle
gcode:
  SET_PIN PIN=spindle VALUE=0

[gcode_macro G20]
gcode:
  RESPOND MSG="Warning: Use G21 (mm) in Klipper CNC"

[gcode_macro G54]
gcode:
  RESTORE_GCODE_STATE NAME=WCS_G54`;

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
      {/* Connection & Machine Envelope Form */}
      <form
        onSubmit={handleSave}
        className="lg:col-span-7 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Klipper Host & CNC Table Configuration
            </h2>
            <p className="text-xs text-slate-400">
              Connect to a live Moonraker instance or tune table dimensions and spindle scaling
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

        {/* Source Mode Selector */}
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

        {/* Table Envelope & Stock */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Table X (mm)</span>
            <input
              type="number"
              min={50}
              max={2500}
              value={draft.bedSize.x}
              onChange={(e) =>
                setDraft({ ...draft, bedSize: { ...draft.bedSize, x: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Table Y (mm)</span>
            <input
              type="number"
              min={50}
              max={2500}
              value={draft.bedSize.y}
              onChange={(e) =>
                setDraft({ ...draft, bedSize: { ...draft.bedSize, y: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Z Travel (mm)</span>
            <input
              type="number"
              min={20}
              max={600}
              value={draft.bedSize.z}
              onChange={(e) =>
                setDraft({ ...draft, bedSize: { ...draft.bedSize, z: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Stock Width X (mm)</span>
            <input
              type="number"
              min={10}
              max={2000}
              value={draft.stockSize.x}
              onChange={(e) =>
                setDraft({ ...draft, stockSize: { ...draft.stockSize, x: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Stock Depth Y (mm)</span>
            <input
              type="number"
              min={10}
              max={2000}
              value={draft.stockSize.y}
              onChange={(e) =>
                setDraft({ ...draft, stockSize: { ...draft.stockSize, y: Number(e.target.value) } })
              }
              className="bg-[#0e1117] border border-slate-700 rounded px-3 py-2 font-mono text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-400">Stock Height Z (mm)</span>
            <input
              type="number"
              min={1}
              max={200}
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

      {/* Klipper CNC printer.cfg Reference */}
      <section className="lg:col-span-5 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Klipper CNC Firmware Reference
            </h2>
            <p className="text-xs text-slate-400">
              Add these macros to printer.cfg for M3/M5 spindle and G54 support
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
