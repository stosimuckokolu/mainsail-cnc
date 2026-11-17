import {
  ActiveHeadTool,
  ConsoleEntry,
  KlipperTelemetry,
  LiveTraceSegment,
  MachineConfig,
  MoveType,
  ParsedGCode,
  ToolpathSegment,
  Vec3,
  WcsName,
} from '../types/cnc';
import { parseGCode } from '../utils/gcodeParser';
import { MoonrakerClient, MoonrakerStatusPayload } from './moonrakerClient';

interface QueuedMotionSegment extends ToolpathSegment {
  isMachineCoords: boolean;
  progressSoFar: number;
  lengthMm: number;
}

export interface EngineCallbacks {
  onTelemetry: (t: KlipperTelemetry) => void;
  onLiveTrace: (segment: LiveTraceSegment) => void;
  onClearLiveTrace: () => void;
  onConsoleEntry: (entry: ConsoleEntry) => void;
}

function nowTime(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toolCodeToActiveTool(code: number): ActiveHeadTool {
  if (code >= 1 && code <= 14) {
    return { mode: 'v_drill', index: code, label: `Top Drill V${code} (T${code})` };
  }
  if (code >= 21 && code <= 26) {
    const idx = code - 20;
    return { mode: 'h_drill', index: idx, label: `Side Drill H${idx} (T${code})` };
  }
  if (code === 30 || code === 90) {
    return { mode: 'saw', index: 0, label: 'Circular Saw (T30)' };
  }
  return { mode: 'spindle', index: 0, label: 'Main Spindle (T0)' };
}

export class KlipperCncEngine {
  private config: MachineConfig;
  private telemetry: KlipperTelemetry;
  private callbacks: EngineCallbacks;
  private moonraker: MoonrakerClient;

  private motionQueue: QueuedMotionSegment[] = [];
  private activeSegment: QueuedMotionSegment | null = null;
  private jobSegments: ToolpathSegment[] = [];
  private jobLinesCount = 0;
  private lastTickTime = 0;
  private rafId: number | null = null;
  private lastUiEmit = 0;
  private lastRecordedMachinePos: Vec3 = { x: 0, y: 0, z: 120 };

  constructor(initialConfig: MachineConfig, callbacks: EngineCallbacks) {
    this.config = initialConfig;
    this.callbacks = callbacks;

    const defaultWcs: Vec3 = { x: 0, y: 0, z: initialConfig.stockSize.z };
    this.telemetry = {
      connectionMode: 'emulator',
      connectionStatus: 'connected',
      statusMessage: 'SCM Tech 99L Klipper Motion Planner active',
      machineState: 'homed',
      homedAxes: { x: true, y: true, z: true },
      machinePos: { x: 0, y: 0, z: defaultWcs.z + 45 },
      workPos: { x: 0, y: 0, z: 45 },
      activeWcs: 'G54',
      wcsOffsets: {
        G54: { ...defaultWcs },
        G55: { x: 1400, y: 0, z: initialConfig.stockSize.z },
        G56: { x: 0, y: -500, z: initialConfig.stockSize.z },
        G57: { x: 300, y: -150, z: initialConfig.stockSize.z },
        G58: { x: 1000, y: -200, z: initialConfig.stockSize.z },
        G59: { x: 2000, y: -200, z: initialConfig.stockSize.z },
      },
      liveVelocity: 0,
      feedrateOverride: 100,
      spindleRpm: 0,
      spindleTargetRpm: 0,
      spindleOverride: 100,
      activeTool: { mode: 'spindle', index: 0, label: 'Main Spindle (T0)' },
      activeLineIndex: -1,
      jobProgress: 0,
      jobFilename: null,
      jobElapsedSec: 0,
      isJobRunning: false,
      isJobPaused: false,
      klipperVersion: 'v0.12.0-scm-tech99l',
    };
    this.lastRecordedMachinePos = { ...this.telemetry.machinePos };

    this.moonraker = new MoonrakerClient({
      onStatusChange: (status, message) => {
        if (this.telemetry.connectionMode !== 'moonraker') return;
        this.telemetry.connectionStatus = status;
        this.telemetry.statusMessage = message;
        if (status === 'disconnected' || status === 'error') {
          this.telemetry.machineState = 'offline';
        }
        this.emitTelemetryNow();
        this.logConsole(status === 'error' ? 'error' : 'info', message);
      },
      onPrinterInfo: (info) => {
        if (this.telemetry.connectionMode !== 'moonraker') return;
        this.telemetry.klipperVersion = info.softwareVersion;
        if (info.state === 'ready') this.telemetry.machineState = 'ready';
        else if (info.state === 'shutdown') this.telemetry.machineState = 'estop';
        this.emitTelemetryNow();
        this.logConsole('rx', `// Klipper ${info.softwareVersion}: ${info.stateMessage}`);
      },
      onTelemetryUpdate: (payload) => {
        if (this.telemetry.connectionMode !== 'moonraker') return;
        this.handleMoonrakerPayload(payload);
      },
      onGcodeResponse: (line) => {
        if (this.telemetry.connectionMode !== 'moonraker') return;
        this.logConsole(line.startsWith('!!') ? 'error' : 'rx', line);
      },
    });

    this.startLoop();
  }

  public getTelemetry(): KlipperTelemetry {
    return this.telemetry;
  }

  public getMoonrakerClient(): MoonrakerClient {
    return this.moonraker;
  }

  public updateConfig(next: MachineConfig): void {
    this.config = next;
  }

  public selectHeadTool(tool: ActiveHeadTool): void {
    this.telemetry.activeTool = tool;
    const tCode =
      tool.mode === 'v_drill'
        ? tool.index
        : tool.mode === 'h_drill'
          ? 20 + tool.index
          : tool.mode === 'saw'
            ? 30
            : 0;
    if (this.telemetry.connectionMode === 'moonraker') {
      this.sendMdiCommand(`T${tCode}`);
    } else {
      this.logConsole('info', `Selected head unit: ${tool.label}`);
    }
    this.emitTelemetryNow();
  }

  public setConnectionMode(mode: 'emulator' | 'moonraker'): void {
    if (mode === this.telemetry.connectionMode) return;
    this.motionQueue = [];
    this.activeSegment = null;
    this.telemetry.isJobRunning = false;
    this.telemetry.isJobPaused = false;
    this.telemetry.liveVelocity = 0;

    if (mode === 'emulator') {
      this.moonraker.disconnect();
      this.telemetry.connectionMode = 'emulator';
      this.telemetry.connectionStatus = 'connected';
      this.telemetry.statusMessage = 'SCM Tech 99L Klipper Motion Planner active';
      this.telemetry.machineState = 'homed';
      this.telemetry.klipperVersion = 'v0.12.0-scm-tech99l';
      this.logConsole('info', 'Switched to Local SCM Tech 99L Bench Motion Planner');
      this.emitTelemetryNow();
    } else {
      this.telemetry.connectionMode = 'moonraker';
      this.telemetry.connectionStatus = 'connecting';
      this.telemetry.machineState = 'offline';
      this.moonraker.connect(this.config.moonrakerUrl, this.config.spindleOutputPin);
      this.emitTelemetryNow();
    }
  }

  public connectMoonraker(url: string): void {
    this.config = { ...this.config, moonrakerUrl: url };
    this.telemetry.connectionMode = 'moonraker';
    this.moonraker.connect(url, this.config.spindleOutputPin);
    this.emitTelemetryNow();
  }

  private handleMoonrakerPayload(payload: MoonrakerStatusPayload): void {
    if (payload.toolhead) {
      if (typeof payload.toolhead.homed_axes === 'string') {
        const ha = payload.toolhead.homed_axes.toLowerCase();
        this.telemetry.homedAxes = {
          x: ha.includes('x'),
          y: ha.includes('y'),
          z: ha.includes('z'),
        };
      }
      if (Array.isArray(payload.toolhead.position) && payload.toolhead.position.length >= 3) {
        const [x, y, z] = payload.toolhead.position;
        this.updateLiveMachinePosition({ x, y, z });
      }
    }

    if (payload.motion_report) {
      if (
        Array.isArray(payload.motion_report.live_position) &&
        payload.motion_report.live_position.length >= 3
      ) {
        const [x, y, z] = payload.motion_report.live_position;
        this.updateLiveMachinePosition({ x, y, z });
      }
      if (typeof payload.motion_report.live_velocity === 'number') {
        this.telemetry.liveVelocity = payload.motion_report.live_velocity * 60;
      }
    }

    if (payload.gcode_move) {
      if (Array.isArray(payload.gcode_move.homing_origin) && payload.gcode_move.homing_origin.length >= 3) {
        const [ox, oy, oz] = payload.gcode_move.homing_origin;
        this.telemetry.wcsOffsets[this.telemetry.activeWcs] = { x: ox, y: oy, z: oz };
      }
      if (Array.isArray(payload.gcode_move.gcode_position) && payload.gcode_move.gcode_position.length >= 3) {
        const [gx, gy, gz] = payload.gcode_move.gcode_position;
        this.telemetry.workPos = { x: gx, y: gy, z: gz };
      }
      if (typeof payload.gcode_move.speed_factor === 'number') {
        this.telemetry.feedrateOverride = Math.round(payload.gcode_move.speed_factor * 100);
      }
    }

    const pinKey = this.config.spindleOutputPin.includes(' ')
      ? this.config.spindleOutputPin
      : `output_pin ${this.config.spindleOutputPin}`;
    const pinObj = payload[pinKey] as { value?: number } | undefined;
    if (pinObj && typeof pinObj.value === 'number') {
      this.telemetry.spindleTargetRpm = Math.round(pinObj.value * this.config.spindleMaxRpm);
      this.telemetry.spindleRpm = this.telemetry.spindleTargetRpm;
    } else if (payload.fan && typeof payload.fan.speed === 'number') {
      this.telemetry.spindleTargetRpm = Math.round(payload.fan.speed * this.config.spindleMaxRpm);
      this.telemetry.spindleRpm = this.telemetry.spindleTargetRpm;
    }

    if (payload.virtual_sdcard) {
      if (typeof payload.virtual_sdcard.is_active === 'boolean') {
        this.telemetry.isJobRunning = payload.virtual_sdcard.is_active;
      }
      if (typeof payload.virtual_sdcard.progress === 'number') {
        this.telemetry.jobProgress = payload.virtual_sdcard.progress;
        if (this.jobLinesCount > 0) {
          this.telemetry.activeLineIndex = Math.min(
            this.jobLinesCount - 1,
            Math.floor(payload.virtual_sdcard.progress * this.jobLinesCount),
          );
        }
      }
    }

    if (payload.print_stats) {
      if (payload.print_stats.filename) {
        this.telemetry.jobFilename = payload.print_stats.filename;
      }
      if (typeof payload.print_stats.print_duration === 'number') {
        this.telemetry.jobElapsedSec = payload.print_stats.print_duration;
      }
      const st = payload.print_stats.state;
      if (st === 'printing') {
        this.telemetry.machineState = 'running';
        this.telemetry.isJobRunning = true;
        this.telemetry.isJobPaused = false;
      } else if (st === 'paused') {
        this.telemetry.machineState = 'paused';
        this.telemetry.isJobPaused = true;
      } else if (st === 'standby' || st === 'complete' || st === 'cancelled') {
        this.telemetry.isJobRunning = false;
        this.telemetry.isJobPaused = false;
        this.telemetry.machineState =
          this.telemetry.homedAxes.x && this.telemetry.homedAxes.y ? 'homed' : 'ready';
      } else if (st === 'error') {
        this.telemetry.machineState = 'estop';
      }
    }

    if (payload.webhooks?.state === 'shutdown') {
      this.telemetry.machineState = 'estop';
    }

    this.emitTelemetryNow();
  }

  private updateLiveMachinePosition(nextPos: Vec3, explicitType?: MoveType): void {
    const prev = this.lastRecordedMachinePos;
    const dist = Math.hypot(nextPos.x - prev.x, nextPos.y - prev.y, nextPos.z - prev.z);

    this.telemetry.machinePos = { ...nextPos };
    const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
    this.telemetry.workPos = {
      x: nextPos.x - wcs.x,
      y: nextPos.y - wcs.y,
      z: nextPos.z - wcs.z,
    };

    if (dist > 0.05) {
      let moveType: MoveType = explicitType ?? 'cut';
      if (!explicitType) {
        const horiz = Math.hypot(nextPos.x - prev.x, nextPos.y - prev.y);
        if (this.telemetry.spindleRpm === 0 && this.telemetry.workPos.z > 0.5) {
          moveType = 'rapid';
        } else if (horiz < 0.05 && nextPos.z < prev.z) {
          moveType = 'plunge';
        } else if (this.telemetry.liveVelocity > this.config.defaultRapidFeed * 0.78 && this.telemetry.workPos.z > 0.5) {
          moveType = 'rapid';
        } else {
          moveType = 'cut';
        }
      }

      this.callbacks.onLiveTrace({
        start: { ...prev },
        end: { ...nextPos },
        type: moveType,
        spindleRpm: this.telemetry.spindleRpm,
      });
      this.lastRecordedMachinePos = { ...nextPos };
    }
  }

  public setJobPreview(filename: string | null, parsed: ParsedGCode): void {
    this.telemetry.jobFilename = filename;
    this.jobSegments = parsed.segments;
    this.jobLinesCount = parsed.lines.length;
    if (!this.telemetry.isJobRunning) {
      this.telemetry.jobProgress = 0;
      this.telemetry.activeLineIndex = -1;
      this.telemetry.jobElapsedSec = 0;
    }
    this.emitTelemetryNow();
  }

  public startJob(filename: string, parsed: ParsedGCode, rawContent?: string): void {
    this.setJobPreview(filename, parsed);
    if (this.telemetry.connectionMode === 'moonraker') {
      if (rawContent) {
        this.logConsole('tx', `Uploading & starting ${filename} on Moonraker...`);
        this.moonraker
          .uploadGcodeFile(filename, rawContent, true)
          .catch((err) => this.logConsole('error', `Start failed: ${err.message}`));
      } else {
        this.moonraker
          .startFile(filename)
          .catch((err) => this.logConsole('error', `Start failed: ${err.message}`));
      }
      return;
    }

    if (this.telemetry.machineState === 'estop') {
      this.logConsole('error', '!! Cannot start job while E-Stop is active. Run FIRMWARE_RESTART.');
      return;
    }

    this.motionQueue = parsed.segments.map((seg) => ({
      ...seg,
      isMachineCoords: false,
      progressSoFar: 0,
      lengthMm: Math.hypot(
        seg.end.x - seg.start.x,
        seg.end.y - seg.start.y,
        seg.end.z - seg.start.z,
      ),
    }));
    this.activeSegment = null;
    this.telemetry.isJobRunning = true;
    this.telemetry.isJobPaused = false;
    this.telemetry.machineState = 'running';
    this.telemetry.jobProgress = 0;
    this.telemetry.jobElapsedSec = 0;
    this.telemetry.activeLineIndex = 0;
    this.logConsole('info', `Started SCM Tech 99L job: ${filename} (${parsed.segments.length} segments)`);
    this.emitTelemetryNow();
  }

  public pauseOrResumeJob(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      if (this.telemetry.isJobPaused) {
        this.moonraker.resumeJob().catch((e) => this.logConsole('error', e.message));
      } else {
        this.moonraker.pauseJob().catch((e) => this.logConsole('error', e.message));
      }
      return;
    }
    if (!this.telemetry.isJobRunning) return;
    this.telemetry.isJobPaused = !this.telemetry.isJobPaused;
    this.telemetry.machineState = this.telemetry.isJobPaused ? 'paused' : 'running';
    if (this.telemetry.isJobPaused) {
      this.telemetry.liveVelocity = 0;
      this.logConsole('info', 'Job paused (feedhold active)');
    } else {
      this.logConsole('info', 'Job resumed');
    }
    this.emitTelemetryNow();
  }

  public stopJob(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      this.moonraker.cancelJob().catch((e) => this.logConsole('error', e.message));
      return;
    }
    this.motionQueue = [];
    this.activeSegment = null;
    this.telemetry.isJobRunning = false;
    this.telemetry.isJobPaused = false;
    this.telemetry.spindleTargetRpm = 0;
    this.telemetry.liveVelocity = 0;
    this.telemetry.machineState = 'homed';
    this.logConsole('info', 'Job cancelled; spindle & drills retracted (M5)');
    this.emitTelemetryNow();
  }

  public emergencyStop(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      this.moonraker.emergencyStop().catch((e) => this.logConsole('error', e.message));
    }
    this.motionQueue = [];
    this.activeSegment = null;
    this.telemetry.isJobRunning = false;
    this.telemetry.isJobPaused = false;
    this.telemetry.spindleTargetRpm = 0;
    this.telemetry.spindleRpm = 0;
    this.telemetry.liveVelocity = 0;
    this.telemetry.machineState = 'estop';
    this.logConsole('error', '!! EMERGENCY STOP (M112) — Motion halted, heads disabled');
    this.emitTelemetryNow();
  }

  public firmwareRestart(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      this.moonraker.firmwareRestart().catch((e) => this.logConsole('error', e.message));
      this.logConsole('tx', 'FIRMWARE_RESTART');
      return;
    }
    this.telemetry.machineState = 'homed';
    this.telemetry.statusMessage = 'SCM Tech 99L Klipper CNC ready';
    this.logConsole('info', 'FIRMWARE_RESTART complete — SCM Tech 99L ready');
    this.emitTelemetryNow();
  }

  public jogAxis(axis: 'X' | 'Y' | 'Z', deltaMm: number, feedMmMin?: number): void {
    const feed = feedMmMin ?? (axis === 'Z' ? 2400 : 8000);
    if (this.telemetry.connectionMode === 'moonraker') {
      const cmd = `G91\nG0 ${axis}${deltaMm.toFixed(3)} F${feed}\nG90`;
      this.sendMdiCommand(cmd);
      return;
    }
    if (this.telemetry.machineState === 'estop' || this.telemetry.isJobRunning) {
      this.logConsole('error', 'Cannot jog while job is running or E-Stop is active');
      return;
    }
    const { min, max } = this.config.axisBounds;
    const start = { ...this.telemetry.machinePos };
    const end = {
      x: clamp(start.x + (axis === 'X' ? deltaMm : 0), min.x, max.x),
      y: clamp(start.y + (axis === 'Y' ? deltaMm : 0), min.y, max.y),
      z: clamp(start.z + (axis === 'Z' ? deltaMm : 0), min.z, max.z),
    };
    this.enqueueMachineMove(start, end, 'rapid', feed);
    this.logConsole('tx', `G91 G0 ${axis}${deltaMm.toFixed(2)} F${feed}`);
  }

  public homeAxes(axes: 'all' | 'X' | 'Y' | 'Z' = 'all'): void {
    const cmd = axes === 'all' ? 'G28' : `G28 ${axes}`;
    if (this.telemetry.connectionMode === 'moonraker') {
      this.sendMdiCommand(cmd);
      return;
    }
    if (this.telemetry.machineState === 'estop') return;
    const start = { ...this.telemetry.machinePos };
    const end: Vec3 = {
      x: axes === 'all' || axes === 'X' ? 0 : start.x,
      y: axes === 'all' || axes === 'Y' ? 0 : start.y,
      z: axes === 'all' || axes === 'Z' ? Math.max(0, this.config.axisBounds.max.z - 20) : start.z,
    };
    this.telemetry.homedAxes = {
      x: this.telemetry.homedAxes.x || axes === 'all' || axes === 'X',
      y: this.telemetry.homedAxes.y || axes === 'all' || axes === 'Y',
      z: this.telemetry.homedAxes.z || axes === 'all' || axes === 'Z',
    };
    this.enqueueMachineMove(start, end, 'rapid', this.config.defaultRapidFeed);
    this.telemetry.machineState = 'homed';
    this.logConsole('tx', cmd);
  }

  public probeZ(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      this.sendMdiCommand(`PROBE\nG92 Z${this.config.probePlateThickness.toFixed(3)}\nG0 Z35 F1800`);
      return;
    }
    if (this.telemetry.machineState === 'estop') return;
    const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
    const stockTopMachineZ = this.config.stockEnabled ? this.config.stockSize.z : 0;
    const start = { ...this.telemetry.machinePos };
    const touchPos = { x: start.x, y: start.y, z: stockTopMachineZ };
    const retractPos = { x: start.x, y: start.y, z: stockTopMachineZ + 35 };
    wcs.z = stockTopMachineZ;
    this.enqueueMachineMove(start, touchPos, 'plunge', 450);
    this.enqueueMachineMove(touchPos, retractPos, 'rapid', 2400);
    this.logConsole('tx', `PROBE -> G92 Z0.000 (${this.telemetry.activeWcs} Z=${wcs.z.toFixed(2)})`);
    this.emitTelemetryNow();
  }

  public zeroWorkAxis(axis: 'X' | 'Y' | 'Z' | 'XY' | 'ALL'): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      const parts: string[] = [];
      if (axis === 'X' || axis === 'XY' || axis === 'ALL') parts.push('X0');
      if (axis === 'Y' || axis === 'XY' || axis === 'ALL') parts.push('Y0');
      if (axis === 'Z' || axis === 'ALL') parts.push('Z0');
      this.sendMdiCommand(`G92 ${parts.join(' ')}`);
      return;
    }
    const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
    const m = this.telemetry.machinePos;
    if (axis === 'X' || axis === 'XY' || axis === 'ALL') wcs.x = m.x;
    if (axis === 'Y' || axis === 'XY' || axis === 'ALL') wcs.y = m.y;
    if (axis === 'Z' || axis === 'ALL') wcs.z = m.z;
    this.telemetry.workPos = {
      x: m.x - wcs.x,
      y: m.y - wcs.y,
      z: m.z - wcs.z,
    };
    this.logConsole('info', `${this.telemetry.activeWcs} zeroed (${axis}) at MCS (${m.x.toFixed(1)}, ${m.y.toFixed(1)}, ${m.z.toFixed(1)})`);
    this.emitTelemetryNow();
  }

  public goToWorkZero(): void {
    if (this.telemetry.connectionMode === 'moonraker') {
      this.sendMdiCommand('G90\nG0 Z45 F3000\nG0 X0 Y0 F12000');
      return;
    }
    const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
    const start = { ...this.telemetry.machinePos };
    const safeZ = Math.min(this.config.axisBounds.max.z, Math.max(start.z, wcs.z + 40));
    const lift = { x: start.x, y: start.y, z: safeZ };
    const target = { x: wcs.x, y: wcs.y, z: safeZ };
    this.enqueueMachineMove(start, lift, 'rapid', this.config.defaultRapidFeed);
    this.enqueueMachineMove(lift, target, 'rapid', this.config.defaultRapidFeed);
    this.logConsole('tx', 'G90 G0 Z40 -> G0 X0 Y0');
  }

  public setActiveWcs(wcs: WcsName): void {
    this.telemetry.activeWcs = wcs;
    const off = this.telemetry.wcsOffsets[wcs];
    this.telemetry.workPos = {
      x: this.telemetry.machinePos.x - off.x,
      y: this.telemetry.machinePos.y - off.y,
      z: this.telemetry.machinePos.z - off.z,
    };
    if (this.telemetry.connectionMode === 'moonraker') {
      this.sendMdiCommand(wcs);
    } else {
      this.logConsole('info', `Active Work Coordinate System set to ${wcs}`);
    }
    this.emitTelemetryNow();
  }

  public setFeedrateOverride(pct: number): void {
    const clamped = Math.max(10, Math.min(200, Math.round(pct)));
    this.telemetry.feedrateOverride = clamped;
    if (this.telemetry.connectionMode === 'moonraker') {
      this.moonraker.sendGcode(`M220 S${clamped}`).catch(() => {});
    }
    this.emitTelemetryNow();
  }

  public setSpindle(rpm: number): void {
    const clamped = Math.max(0, Math.min(this.config.spindleMaxRpm, Math.round(rpm)));
    this.telemetry.spindleTargetRpm = clamped;
    if (this.telemetry.connectionMode === 'moonraker') {
      const cmd = clamped > 0 ? `M3 S${clamped}` : 'M5';
      this.sendMdiCommand(cmd);
    } else {
      this.logConsole('tx', clamped > 0 ? `M3 S${clamped}` : 'M5');
    }
    this.emitTelemetryNow();
  }

  public sendMdiCommand(rawCommand: string): void {
    const trimmed = rawCommand.trim();
    if (!trimmed) return;
    this.logConsole('tx', trimmed);

    if (this.telemetry.connectionMode === 'moonraker') {
      this.moonraker.sendGcode(trimmed).catch((err) => {
        this.logConsole('error', `!! ${err.message}`);
      });
      return;
    }

    const upper = trimmed.toUpperCase();
    if (upper === 'M112') {
      this.emergencyStop();
      return;
    }
    if (upper === 'FIRMWARE_RESTART' || upper === 'RESTART') {
      this.firmwareRestart();
      return;
    }
    if (upper.startsWith('G28')) {
      this.homeAxes('all');
      return;
    }
    if (upper === 'M5') {
      this.telemetry.spindleTargetRpm = 0;
      this.emitTelemetryNow();
      return;
    }

    const tMatch = upper.match(/\bT(\d+)\b/);
    if (tMatch) {
      this.telemetry.activeTool = toolCodeToActiveTool(parseInt(tMatch[1], 10));
    }

    const prefix = `G90\nG0 X${this.telemetry.workPos.x.toFixed(4)} Y${this.telemetry.workPos.y.toFixed(4)} Z${this.telemetry.workPos.z.toFixed(4)}\n`;
    const parsed = parseGCode(prefix + trimmed, this.config.defaultRapidFeed, this.config.defaultCutFeed);

    const sMatch = upper.match(/M3\s+S(\d+)/);
    if (sMatch) {
      this.telemetry.spindleTargetRpm = Math.min(this.config.spindleMaxRpm, parseInt(sMatch[1], 10));
    } else if (upper.includes('M3') && this.telemetry.spindleTargetRpm === 0) {
      this.telemetry.spindleTargetRpm = 14000;
    }

    const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
    const { min, max } = this.config.axisBounds;
    for (const seg of parsed.segments) {
      const lengthMm = Math.hypot(
        seg.end.x - seg.start.x,
        seg.end.y - seg.start.y,
        seg.end.z - seg.start.z,
      );
      if (lengthMm < 1e-4) continue;
      this.motionQueue.push({
        start: {
          x: clamp(seg.start.x + wcs.x, min.x, max.x),
          y: clamp(seg.start.y + wcs.y, min.y, max.y),
          z: clamp(seg.start.z + wcs.z, min.z, max.z),
        },
        end: {
          x: clamp(seg.end.x + wcs.x, min.x, max.x),
          y: clamp(seg.end.y + wcs.y, min.y, max.y),
          z: clamp(seg.end.z + wcs.z, min.z, max.z),
        },
        type: seg.type,
        feedrate: seg.feedrate,
        lineNumber: -1,
        spindleRpm: seg.spindleRpm || this.telemetry.spindleTargetRpm,
        toolCode: seg.toolCode,
        isMachineCoords: true,
        progressSoFar: 0,
        lengthMm,
      });
    }
    this.logConsole('rx', 'ok');
    this.emitTelemetryNow();
  }

  public clearLiveTrace(): void {
    this.callbacks.onClearLiveTrace();
    this.logConsole('info', 'Cleared live table toolpath trace');
  }

  private enqueueMachineMove(start: Vec3, end: Vec3, type: MoveType, feedrate: number): void {
    const lengthMm = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    if (lengthMm < 1e-4) return;
    this.motionQueue.push({
      start,
      end,
      type,
      feedrate,
      lineNumber: -1,
      spindleRpm: this.telemetry.spindleTargetRpm,
      isMachineCoords: true,
      progressSoFar: 0,
      lengthMm,
    });
  }

  private startLoop(): void {
    this.lastTickTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - this.lastTickTime) / 1000);
      this.lastTickTime = now;

      if (this.telemetry.connectionMode === 'emulator') {
        this.stepEmulator(dt, now);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stepEmulator(dt: number, now: number): void {
    const rpmDiff = this.telemetry.spindleTargetRpm - this.telemetry.spindleRpm;
    if (Math.abs(rpmDiff) > 5) {
      this.telemetry.spindleRpm += rpmDiff * Math.min(1, dt * 8);
    } else {
      this.telemetry.spindleRpm = this.telemetry.spindleTargetRpm;
    }

    if (this.telemetry.machineState === 'estop' || this.telemetry.isJobPaused) {
      if (now - this.lastUiEmit > 120) {
        this.emitTelemetryNow();
        this.lastUiEmit = now;
      }
      return;
    }

    if (this.telemetry.isJobRunning) {
      this.telemetry.jobElapsedSec += dt;
    }

    let movedThisFrame = false;
    const overrideScale = this.telemetry.feedrateOverride / 100;
    let remainingTime = dt;
    let latestType: MoveType | undefined;
    const { min, max } = this.config.axisBounds;

    while (remainingTime > 1e-5) {
      if (!this.activeSegment) {
        const next = this.motionQueue.shift();
        if (!next) {
          if (this.telemetry.isJobRunning) {
            this.telemetry.isJobRunning = false;
            this.telemetry.jobProgress = 1;
            this.telemetry.spindleTargetRpm = 0;
            this.telemetry.machineState = 'homed';
            this.logConsole('info', `Job completed in ${this.telemetry.jobElapsedSec.toFixed(1)}s`);
            this.emitTelemetryNow();
          }
          this.telemetry.liveVelocity = 0;
          break;
        }
        if (!next.isMachineCoords) {
          const wcs = this.telemetry.wcsOffsets[this.telemetry.activeWcs];
          next.start = {
            x: clamp(next.start.x + wcs.x, min.x, max.x),
            y: clamp(next.start.y + wcs.y, min.y, max.y),
            z: clamp(next.start.z + wcs.z, min.z, max.z),
          };
          next.end = {
            x: clamp(next.end.x + wcs.x, min.x, max.x),
            y: clamp(next.end.y + wcs.y, min.y, max.y),
            z: clamp(next.end.z + wcs.z, min.z, max.z),
          };
          next.lengthMm = Math.hypot(
            next.end.x - next.start.x,
            next.end.y - next.start.y,
            next.end.z - next.start.z,
          );
          next.isMachineCoords = true;
        }
        this.activeSegment = next;
        if (next.toolCode !== undefined) {
          this.telemetry.activeTool = toolCodeToActiveTool(next.toolCode);
        }
        if (next.spindleRpm !== undefined && this.telemetry.isJobRunning) {
          this.telemetry.spindleTargetRpm = next.spindleRpm;
        }
        if (next.lineNumber >= 0) {
          this.telemetry.activeLineIndex = next.lineNumber;
        }
      }

      const seg = this.activeSegment;
      if (seg.lengthMm < 1e-5) {
        this.activeSegment = null;
        continue;
      }

      const effectiveFeedMmMin =
        seg.type === 'rapid'
          ? seg.feedrate * Math.min(1.5, Math.max(0.25, overrideScale))
          : seg.feedrate * overrideScale;
      const speedMmSec = Math.max(1, effectiveFeedMmMin / 60);
      this.telemetry.liveVelocity = effectiveFeedMmMin;
      latestType = seg.type;

      const distRemaining = seg.lengthMm - seg.progressSoFar;
      const travelPossible = speedMmSec * remainingTime;

      if (travelPossible >= distRemaining) {
        this.telemetry.machinePos = { ...seg.end };
        remainingTime -= distRemaining / speedMmSec;
        this.activeSegment = null;
        movedThisFrame = true;
        this.updateLiveMachinePosition(this.telemetry.machinePos, seg.type);
      } else {
        seg.progressSoFar += travelPossible;
        const t = seg.progressSoFar / Math.max(1e-6, seg.lengthMm);
        this.telemetry.machinePos = {
          x: seg.start.x + (seg.end.x - seg.start.x) * t,
          y: seg.start.y + (seg.end.y - seg.start.y) * t,
          z: seg.start.z + (seg.end.z - seg.start.z) * t,
        };
        remainingTime = 0;
        movedThisFrame = true;
      }
    }

    if (movedThisFrame) {
      this.updateLiveMachinePosition(this.telemetry.machinePos, latestType);
      if (this.telemetry.isJobRunning && this.jobSegments.length > 0) {
        const done = this.jobSegments.length - this.motionQueue.length - (this.activeSegment ? 1 : 0);
        this.telemetry.jobProgress = Math.max(0, Math.min(1, done / this.jobSegments.length));
      }
    }

    if (now - this.lastUiEmit > 60) {
      this.emitTelemetryNow();
      this.lastUiEmit = now;
    }
  }

  private emitTelemetryNow(): void {
    this.callbacks.onTelemetry({
      ...this.telemetry,
      activeTool: { ...this.telemetry.activeTool },
      homedAxes: { ...this.telemetry.homedAxes },
      machinePos: { ...this.telemetry.machinePos },
      workPos: { ...this.telemetry.workPos },
      wcsOffsets: {
        G54: { ...this.telemetry.wcsOffsets.G54 },
        G55: { ...this.telemetry.wcsOffsets.G55 },
        G56: { ...this.telemetry.wcsOffsets.G56 },
        G57: { ...this.telemetry.wcsOffsets.G57 },
        G58: { ...this.telemetry.wcsOffsets.G58 },
        G59: { ...this.telemetry.wcsOffsets.G59 },
      },
    });
  }

  private logConsole(direction: ConsoleEntry['direction'], text: string): void {
    this.callbacks.onConsoleEntry({
      id: makeId(),
      timestamp: nowTime(),
      direction,
      text,
    });
  }

  public dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.moonraker.disconnect();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
