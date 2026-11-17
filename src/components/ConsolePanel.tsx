import React, { useEffect, useRef, useState } from 'react';
import { ConsoleEntry } from '../types/cnc';
import { Send, Trash2 } from 'lucide-react';

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  onSendCommand: (cmd: string) => void;
  onClearConsole: () => void;
  compact?: boolean;
}

const QUICK_MACROS = [
  { label: 'G28', cmd: 'G28' },
  { label: 'G92 X0 Y0', cmd: 'G92 X0 Y0' },
  { label: 'M3 S12000', cmd: 'M3 S12000' },
  { label: 'M5', cmd: 'M5' },
  { label: 'Demo Cut', cmd: 'G1 X350 Y-250 F4500' },
  { label: 'Restart', cmd: 'FIRMWARE_RESTART' },
];

export const ConsolePanel: React.FC<ConsolePanelProps> = ({
  entries,
  onSendCommand,
  onClearConsole,
  compact = false,
}) => {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [entries.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd) return;
    onSendCommand(cmd);
    setHistory((prev) => [cmd, ...prev.slice(0, 49)]);
    setHistIdx(-1);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = Math.min(history.length - 1, histIdx + 1);
      setHistIdx(nextIdx);
      setInput(history[nextIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx <= 0) {
        setHistIdx(-1);
        setInput('');
      } else {
        const nextIdx = histIdx - 1;
        setHistIdx(nextIdx);
        setInput(history[nextIdx]);
      }
    }
  };

  return (
    <section className="bg-[#151922] border border-slate-800 rounded-lg p-4 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">MDI & Klipper Console</h2>
        <button
          type="button"
          onClick={onClearConsole}
          className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>
      </div>

      {/* Quick CNC Macros */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_MACROS.map((m) => (
          <button
            key={m.label}
            type="button"
            onClick={() => onSendCommand(m.cmd)}
            className="px-2 py-1 text-[11px] font-mono text-slate-300 bg-[#1a202c] hover:bg-slate-700/70 border border-slate-700/80 rounded transition-colors whitespace-nowrap shrink-0"
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Output Log */}
      <div
        className={`bg-[#0d1016] border border-slate-800 rounded-md p-2.5 overflow-y-auto font-mono text-xs space-y-1 ${
          compact ? 'h-32' : 'h-[420px]'
        }`}
      >
        {entries.map((entry) => {
          const color =
            entry.direction === 'tx'
              ? 'text-sky-400'
              : entry.direction === 'error'
                ? 'text-rose-400'
                : entry.direction === 'info'
                  ? 'text-emerald-400'
                  : 'text-slate-300';
          return (
            <div key={entry.id} className="flex gap-2 leading-relaxed">
              <span className="text-slate-600 shrink-0">{entry.timestamp}</span>
              <span className={`${color} break-all`}>{entry.text}</span>
            </div>
          );
        })}
        <div ref={logEndRef} />
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send G-code or Klipper command (e.g. G1 X80 Y60 F1200)"
          className="flex-1 min-w-0 bg-[#0d1016] border border-slate-700 focus:border-sky-500 focus:outline-none rounded-md px-3 py-2 text-xs font-mono text-slate-100 placeholder:text-slate-500"
        />
        <button
          type="submit"
          className="px-3.5 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          Send
        </button>
      </form>
    </section>
  );
};
