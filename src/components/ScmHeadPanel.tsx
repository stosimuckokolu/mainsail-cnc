import React from 'react';
import { ActiveHeadTool } from '../types/cnc';

interface ScmHeadPanelProps {
  activeTool: ActiveHeadTool;
  onSelectTool: (tool: ActiveHeadTool) => void;
}

export const ScmHeadPanel: React.FC<ScmHeadPanelProps> = ({
  activeTool,
  onSelectTool,
}) => {
  return (
    <section className="bg-[#151922] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">SCM Tech 99L Head Unit</h2>
        <span className="text-xs font-mono text-sky-300">{activeTool.label}</span>
      </div>

      {/* Main Spindle & Circular Saw */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onSelectTool({ mode: 'spindle', index: 0, label: 'Main Spindle (T0)' })
          }
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
            activeTool.mode === 'spindle'
              ? 'bg-sky-600/25 border-sky-500 text-sky-200'
              : 'bg-[#1a202c] border-slate-700/80 text-slate-300 hover:bg-slate-700/60'
          }`}
        >
          Main Spindle (T0)
        </button>

        <button
          type="button"
          onClick={() =>
            onSelectTool({ mode: 'saw', index: 0, label: 'Circular Saw (T30)' })
          }
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
            activeTool.mode === 'saw'
              ? 'bg-sky-600/25 border-sky-500 text-sky-200'
              : 'bg-[#1a202c] border-slate-700/80 text-slate-300 hover:bg-slate-700/60'
          }`}
        >
          Circular Saw (T30)
        </button>
      </div>

      {/* 14 Top (Vertical) Drills */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-slate-400">
          Top Vertical Drills (14 · 9X + 5Y)
        </span>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 14 }, (_, idx) => {
            const num = idx + 1;
            const active = activeTool.mode === 'v_drill' && activeTool.index === num;
            return (
              <button
                key={num}
                type="button"
                onClick={() =>
                  onSelectTool({
                    mode: 'v_drill',
                    index: num,
                    label: `Top Drill V${num} (T${num})`,
                  })
                }
                className={`py-1 text-[11px] font-mono rounded border transition-colors ${
                  active
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 font-semibold'
                    : 'bg-[#10131b] border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                V{num}
              </button>
            );
          })}
        </div>
      </div>

      {/* 6 Side (Horizontal) Drills */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-slate-400">
          Side Horizontal Drills (6 · 4X + 2Y)
        </span>
        <div className="grid grid-cols-6 gap-1">
          {[
            { num: 1, label: 'H1 +X' },
            { num: 2, label: 'H2 +X' },
            { num: 3, label: 'H3 -X' },
            { num: 4, label: 'H4 -X' },
            { num: 5, label: 'H5 +Y' },
            { num: 6, label: 'H6 -Y' },
          ].map((item) => {
            const active = activeTool.mode === 'h_drill' && activeTool.index === item.num;
            return (
              <button
                key={item.num}
                type="button"
                onClick={() =>
                  onSelectTool({
                    mode: 'h_drill',
                    index: item.num,
                    label: `Side Drill H${item.num} (T${20 + item.num})`,
                  })
                }
                className={`py-1 text-[11px] font-mono rounded border transition-colors ${
                  active
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 font-semibold'
                    : 'bg-[#10131b] border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
