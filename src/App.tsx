import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActiveTab,
  ConsoleEntry,
  GCodeFileItem,
  KlipperTelemetry,
  MachineConfig,
  ParsedGCode,
  WcsName,
} from './types/cnc';
import { parseGCode } from './utils/gcodeParser';
import { SAMPLE_GCODE_FILES } from './utils/sampleGcode';
import { KlipperCncEngine } from './services/klipperCncEngine';
import { CncViewport3D, CncViewportHandle } from './components/CncViewport3D';
import { DroPanel } from './components/DroPanel';
import { JogPanel } from './components/JogPanel';
import { JobControlPanel } from './components/JobControlPanel';
import { ConsolePanel } from './components/ConsolePanel';
import { FilesView } from './components/FilesView';
import { MachineConfigView } from './components/MachineConfigView';
import { Link2, OctagonAlert, RotateCcw } from 'lucide-react';

const INITIAL_CONFIG: MachineConfig = {
  name: 'Mainsail CNC Router',
  moonrakerUrl: 'http://mainsailos.local:7125',
  bedSize: { x: 400, y: 300, z: 100 },
  spindleMaxRpm: 24000,
  spindleOutputPin: 'output_pin spindle',
  defaultRapidFeed: 3200,
  defaultCutFeed: 900,
  probePlateThickness: 12.0,
  stockEnabled: true,
  stockSize: { x: 140, y: 115, z: 18 },
};

const INITIAL_TELEMETRY: KlipperTelemetry = {
  connectionMode: 'emulator',
  connectionStatus: 'connected',
  statusMessage: 'Local Klipper CNC Motion Planner active',
  machineState: 'homed',
  homedAxes: { x: true, y: true, z: true },
  machinePos: { x: 60, y: 45, z: 33 },
  workPos: { x: 0, y: 0, z: 15 },
  activeWcs: 'G54',
  wcsOffsets: {
    G54: { x: 60, y: 45, z: 18 },
    G55: { x: 120, y: 80, z: 18 },
    G56: { x: 200, y: 120, z: 18 },
    G57: { x: 50, y: 50, z: 18 },
    G58: { x: 50, y: 50, z: 18 },
    G59: { x: 50, y: 50, z: 18 },
  },
  liveVelocity: 0,
  feedrateOverride: 100,
  spindleRpm: 0,
  spindleTargetRpm: 0,
  spindleOverride: 100,
  activeLineIndex: -1,
  jobProgress: 0,
  jobFilename: SAMPLE_GCODE_FILES[0].name,
  jobElapsedSec: 0,
  isJobRunning: false,
  isJobPaused: false,
  klipperVersion: 'v0.12.0-cnc-bench',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [config, setConfig] = useState<MachineConfig>(INITIAL_CONFIG);
  const [telemetry, setTelemetry] = useState<KlipperTelemetry>(INITIAL_TELEMETRY);
  const [files, setFiles] = useState<GCodeFileItem[]>(SAMPLE_GCODE_FILES);
  const [activeFilename, setActiveFilename] = useState<string | null>(
    SAMPLE_GCODE_FILES[0].name,
  );
  const [activeGcodeContent, setActiveGcodeContent] = useState<string>(
    SAMPLE_GCODE_FILES[0].content ?? '',
  );
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([
    {
      id: 'boot-1',
      timestamp: new Date().toTimeString().slice(0, 8),
      direction: 'info',
      text: 'Mainsail CNC ready. Run a job, jog axes, or send MDI G-code to trace live on the table.',
    },
  ]);
  const [liveTraceCount, setLiveTraceCount] = useState(0);
  const [moonrakerUrlInput, setMoonrakerUrlInput] = useState(INITIAL_CONFIG.moonrakerUrl);

  const viewportRef = useRef<CncViewportHandle | null>(null);
  const engineRef = useRef<KlipperCncEngine | null>(null);
  const traceCountRef = useRef(0);
  const lastTraceUiUpdateRef = useRef(0);

  // Parsed G-code for planned toolpath preview & execution
  const parsedGCode = useMemo<ParsedGCode | null>(() => {
    if (!activeGcodeContent.trim()) return null;
    return parseGCode(
      activeGcodeContent,
      config.defaultRapidFeed,
      config.defaultCutFeed,
    );
  }, [activeGcodeContent, config.defaultRapidFeed, config.defaultCutFeed]);

  // Initialize Klipper CNC Engine once
  useEffect(() => {
    const engine = new KlipperCncEngine(INITIAL_CONFIG, {
      onTelemetry: (next) => {
        setTelemetry(next);
      },
      onLiveTrace: (seg) => {
        viewportRef.current?.appendLiveSegment(seg);
        traceCountRef.current += 1;
        const now = performance.now();
        if (now - lastTraceUiUpdateRef.current > 120) {
          lastTraceUiUpdateRef.current = now;
          setLiveTraceCount(traceCountRef.current);
        }
      },
      onClearLiveTrace: () => {
        viewportRef.current?.clearLiveTrace();
        traceCountRef.current = 0;
        setLiveTraceCount(0);
      },
      onConsoleEntry: (entry) => {
        setConsoleEntries((prev) => [...prev.slice(-199), entry]);
      },
    });
    engineRef.current = engine;
    setTelemetry(engine.getTelemetry());

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Sync initial G-code preview with engine
  useEffect(() => {
    if (parsedGCode && engineRef.current) {
      engineRef.current.setJobPreview(activeFilename, parsedGCode);
    }
  }, [parsedGCode, activeFilename]);

  const handleSaveConfig = useCallback((next: MachineConfig) => {
    setConfig(next);
    setMoonrakerUrlInput(next.moonrakerUrl);
    engineRef.current?.updateConfig(next);
  }, []);

  const handleStartJob = useCallback(() => {
    if (!parsedGCode || !activeFilename) return;
    engineRef.current?.startJob(activeFilename, parsedGCode, activeGcodeContent);
  }, [parsedGCode, activeFilename, activeGcodeContent]);

  const handleSelectFile = useCallback(
    async (file: GCodeFileItem, autoStart = false) => {
      let content = file.content;
      if (!content && file.source === 'moonraker' && engineRef.current) {
        try {
          content = await engineRef.current
            .getMoonrakerClient()
            .fetchGcodeContent(file.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to fetch file';
          setConsoleEntries((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              timestamp: new Date().toTimeString().slice(0, 8),
              direction: 'error',
              text: msg,
            },
          ]);
          return;
        }
      }
      if (!content) return;
      setActiveFilename(file.name);
      setActiveGcodeContent(content);
      setActiveTab('dashboard');

      if (autoStart) {
        const parsed = parseGCode(content, config.defaultRapidFeed, config.defaultCutFeed);
        engineRef.current?.startJob(file.name, parsed, content);
      }
    },
    [config.defaultRapidFeed, config.defaultCutFeed],
  );

  const handleUploadLocalFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      const item: GCodeFileItem = {
        name: file.name,
        sizeBytes: file.size,
        modified: new Date().toISOString().slice(0, 16).replace('T', ' '),
        source: 'local',
        content,
      };
      setFiles((prev) => [item, ...prev.filter((p) => p.name !== file.name)]);
      setActiveFilename(file.name);
      setActiveGcodeContent(content);
      setActiveTab('dashboard');
    };
    reader.readAsText(file);
  }, []);

  const handleCreateCustomGcode = useCallback((filename: string, content: string) => {
    const item: GCodeFileItem = {
      name: filename,
      sizeBytes: new Blob([content]).size,
      modified: new Date().toISOString().slice(0, 16).replace('T', ' '),
      source: 'local',
      content,
    };
    setFiles((prev) => [item, ...prev.filter((p) => p.name !== filename)]);
    setActiveFilename(filename);
    setActiveGcodeContent(content);
    setActiveTab('dashboard');
  }, []);

  const handleRefreshMoonrakerFiles = useCallback(async () => {
    if (!engineRef.current) return;
    try {
      const remote = await engineRef.current.getMoonrakerClient().listGcodeFiles();
      setFiles((prev) => [
        ...remote,
        ...prev.filter((p) => p.source !== 'moonraker'),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not list Moonraker files';
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          timestamp: new Date().toTimeString().slice(0, 8),
          direction: 'error',
          text: msg,
        },
      ]);
    }
  }, []);

  const machineStateLabel =
    telemetry.machineState === 'estop'
      ? 'E-Stop Active'
      : telemetry.machineState === 'running'
        ? 'Machining'
        : telemetry.machineState === 'paused'
          ? 'Feedhold Paused'
          : telemetry.machineState === 'offline'
            ? 'Offline'
            : 'Ready';

  const machineStateColor =
    telemetry.machineState === 'estop'
      ? 'text-rose-400'
      : telemetry.machineState === 'running'
        ? 'text-emerald-400'
        : telemetry.machineState === 'paused'
          ? 'text-amber-400'
          : telemetry.machineState === 'offline'
            ? 'text-slate-400'
            : 'text-sky-400';

  return (
    <div className="min-h-screen bg-[#0e1116] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones (Wordmark — 4 Nav Links — 1 Primary Action) */}
      <header className="border-b border-slate-800/90 bg-[#131720] px-5 py-3 flex items-center justify-between gap-8">
        <a
          href="#dashboard"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('dashboard');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Mainsail CNC
        </a>

        <nav className="flex items-center gap-6 overflow-x-auto">
          {(
            [
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'files', label: 'G-Code Files' },
              { id: 'console', label: 'Console' },
              { id: 'config', label: 'Machine Config' },
            ] as Array<{ id: ActiveTab; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-1 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === tab.id
                  ? 'border-sky-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="shrink-0">
          {telemetry.machineState === 'estop' ? (
            <button
              type="button"
              onClick={() => engineRef.current?.firmwareRestart()}
              className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Firmware Restart
            </button>
          ) : (
            <button
              type="button"
              onClick={() => engineRef.current?.emergencyStop()}
              className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <OctagonAlert className="w-3.5 h-3.5" />
              Emergency Stop
            </button>
          )}
        </div>
      </header>

      {/* Workspace Connection & Job Toolbar */}
      <div className="border-b border-slate-800/80 bg-[#10141c] px-5 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`font-semibold ${machineStateColor}`}>{machineStateLabel}</span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-slate-400">{telemetry.klipperVersion}</span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <div className="flex items-center gap-1 bg-[#151922] border border-slate-800 rounded p-0.5">
            <button
              type="button"
              onClick={() => engineRef.current?.setConnectionMode('emulator')}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                telemetry.connectionMode === 'emulator'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Local Klipper Bench
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.setConnectionMode('moonraker')}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                telemetry.connectionMode === 'moonraker'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live Moonraker
            </button>
          </div>

          {telemetry.connectionMode === 'moonraker' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                engineRef.current?.connectMoonraker(moonrakerUrlInput);
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={moonrakerUrlInput}
                onChange={(e) => setMoonrakerUrlInput(e.target.value)}
                placeholder="http://mainsailos.local:7125"
                className="bg-[#151922] border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-slate-200 w-56 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                className="px-2.5 py-1 bg-[#1a202c] hover:bg-slate-700 border border-slate-700 rounded text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <Link2 className="w-3 h-3 text-sky-400" />
                Connect
              </button>
              <span className="text-slate-400 font-mono truncate max-w-[240px]">
                {telemetry.connectionStatus}
              </span>
            </form>
          )}
        </div>

        {/* Quick Job File Switcher */}
        <div className="flex items-center gap-2">
          <label className="text-slate-400 whitespace-nowrap" htmlFor="quick-job-select">
            Active Program
          </label>
          <select
            id="quick-job-select"
            value={activeFilename ?? ''}
            onChange={(e) => {
              const found = files.find((f) => f.name === e.target.value);
              if (found) handleSelectFile(found, false);
            }}
            className="bg-[#151922] border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
          >
            {files.map((f) => (
              <option key={`${f.source}-${f.name}`} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 p-4 lg:p-5 max-w-[1680px] w-full mx-auto">
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Focal Anchor: 3D CNC Table & Live Toolpath Generation */}
            <div className="lg:col-span-8 h-[520px] lg:h-[calc(100vh-146px)] min-h-[500px]">
              <CncViewport3D
                ref={viewportRef}
                telemetry={telemetry}
                config={config}
                parsedGCode={parsedGCode}
                liveTraceCount={liveTraceCount}
                onClearTrace={() => engineRef.current?.clearLiveTrace()}
              />
            </div>

            {/* Right Control Deck */}
            <div className="lg:col-span-4 flex flex-col gap-3 lg:max-h-[calc(100vh-146px)] lg:overflow-y-auto pr-0.5">
              <DroPanel
                telemetry={telemetry}
                spindleMaxRpm={config.spindleMaxRpm}
                onZeroAxis={(ax) => engineRef.current?.zeroWorkAxis(ax)}
                onSelectWcs={(wcs: WcsName) => engineRef.current?.setActiveWcs(wcs)}
                onSetSpindle={(rpm) => engineRef.current?.setSpindle(rpm)}
              />

              <JogPanel
                telemetry={telemetry}
                onJog={(axis, delta) => engineRef.current?.jogAxis(axis, delta)}
                onHome={(axes) => engineRef.current?.homeAxes(axes)}
                onProbeZ={() => engineRef.current?.probeZ()}
                onGoToWorkZero={() => engineRef.current?.goToWorkZero()}
              />

              <JobControlPanel
                telemetry={telemetry}
                filename={activeFilename}
                parsedGCode={parsedGCode}
                spindleMaxRpm={config.spindleMaxRpm}
                onStartJob={handleStartJob}
                onPauseResume={() => engineRef.current?.pauseOrResumeJob()}
                onStopJob={() => engineRef.current?.stopJob()}
                onFeedOverride={(pct) => engineRef.current?.setFeedrateOverride(pct)}
                onSetSpindle={(rpm) => engineRef.current?.setSpindle(rpm)}
                onUploadClick={() => setActiveTab('files')}
              />

              <ConsolePanel
                entries={consoleEntries}
                onSendCommand={(cmd) => engineRef.current?.sendMdiCommand(cmd)}
                onClearConsole={() => setConsoleEntries([])}
                compact
              />
            </div>
          </div>
        )}

        {activeTab === 'files' && (
          <FilesView
            files={files}
            activeFilename={activeFilename}
            isMoonrakerConnected={
              telemetry.connectionMode === 'moonraker' &&
              telemetry.connectionStatus === 'connected'
            }
            onSelectFile={handleSelectFile}
            onUploadLocalFile={handleUploadLocalFile}
            onCreateCustomGcode={handleCreateCustomGcode}
            onRefreshMoonraker={handleRefreshMoonrakerFiles}
          />
        )}

        {activeTab === 'console' && (
          <div className="max-w-5xl mx-auto">
            <ConsolePanel
              entries={consoleEntries}
              onSendCommand={(cmd) => engineRef.current?.sendMdiCommand(cmd)}
              onClearConsole={() => setConsoleEntries([])}
              compact={false}
            />
          </div>
        )}

        {activeTab === 'config' && (
          <MachineConfigView
            config={config}
            telemetry={telemetry}
            onSaveConfig={handleSaveConfig}
            onSwitchMode={(mode) => engineRef.current?.setConnectionMode(mode)}
            onConnectMoonraker={(url) => engineRef.current?.connectMoonraker(url)}
          />
        )}
      </main>
    </div>
  );
}
