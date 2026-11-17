import React, { useRef, useState } from 'react';
import { GCodeFileItem } from '../types/cnc';
import { FileCode2, Play, RefreshCw, Upload } from 'lucide-react';

interface FilesViewProps {
  files: GCodeFileItem[];
  activeFilename: string | null;
  isMoonrakerConnected: boolean;
  onSelectFile: (file: GCodeFileItem, autoStart?: boolean) => void;
  onUploadLocalFile: (file: File) => void;
  onCreateCustomGcode: (filename: string, content: string) => void;
  onRefreshMoonraker: () => void;
}

export const FilesView: React.FC<FilesViewProps> = ({
  files,
  activeFilename,
  isMoonrakerConnected,
  onSelectFile,
  onUploadLocalFile,
  onCreateCustomGcode,
  onRefreshMoonraker,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [customName, setCustomName] = useState('custom_pocket.nc');
  const [customBody, setCustomBody] = useState(
    `; Custom Klipper CNC Test Path\nG21\nG90\nM3 S14000\nG0 Z10\nG0 X20 Y20\nG1 Z-1.5 F250\nG1 X80 Y20 F1100\nG1 X80 Y70 F1100\nG1 X20 Y70 F1100\nG1 X20 Y20 F1100\nG0 Z12\nM5\nG0 X0 Y0\n`,
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onUploadLocalFile(f);
    e.target.value = '';
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* File Library */}
      <section className="lg:col-span-7 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">G-Code Files</h2>
            <p className="text-xs text-slate-400">
              Load CNC programs onto the table preview or upload directly to Moonraker
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isMoonrakerConnected && (
              <button
                type="button"
                onClick={onRefreshMoonraker}
                className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700/70 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sync Moonraker
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload .nc / .gcode
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".nc,.gcode,.ngc,.tap,.cnc,.txt"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        </div>

        <div className="border border-slate-800 rounded-md overflow-hidden bg-[#10131b]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#141822] text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3 font-medium">Filename</th>
                <th className="py-2.5 px-3 font-medium">Source</th>
                <th className="py-2.5 px-3 font-medium text-right">Size</th>
                <th className="py-2.5 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {files.map((f) => {
                const isActive = activeFilename === f.name;
                return (
                  <tr
                    key={`${f.source}-${f.name}`}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      isActive ? 'bg-sky-500/10' : ''
                    }`}
                  >
                    <td className="py-2.5 px-3 font-mono text-slate-200">
                      <div className="flex items-center gap-2">
                        <FileCode2 className="w-4 h-4 text-sky-400 shrink-0" />
                        <span className="truncate max-w-[260px]">{f.name}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-slate-400 capitalize">{f.source}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-400">
                      {(f.sizeBytes / 1024).toFixed(1)} KB
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectFile(f, false)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#1a202c] hover:bg-slate-700 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectFile(f, true)}
                          className="px-2.5 py-1 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Play className="w-3 h-3" />
                          Run
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Quick G-Code Composer */}
      <section className="lg:col-span-5 bg-[#151922] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Quick G-Code Editor</h2>
          <p className="text-xs text-slate-400">
            Write or paste CNC G-code and load it directly onto the 3D table
          </p>
        </div>

        <input
          type="text"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          className="bg-[#0e1117] border border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
        />

        <textarea
          value={customBody}
          onChange={(e) => setCustomBody(e.target.value)}
          rows={12}
          spellCheck={false}
          className="bg-[#0e1117] border border-slate-700 rounded-md p-3 text-xs font-mono text-slate-200 leading-5 focus:outline-none focus:border-sky-500 resize-y"
        />

        <button
          type="button"
          onClick={() => onCreateCustomGcode(customName || 'custom.nc', customBody)}
          className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors self-end whitespace-nowrap shrink-0"
        >
          Load to Table
        </button>
      </section>
    </div>
  );
};
