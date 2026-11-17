export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AxisBounds {
  min: Vec3;
  max: Vec3;
}

export type MoveType = 'rapid' | 'cut' | 'plunge' | 'arc';

export type WcsName = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59';

export type WcsOffsetMap = Record<WcsName, Vec3>;

export type HeadToolMode = 'spindle' | 'v_drill' | 'h_drill' | 'saw';

export interface ActiveHeadTool {
  mode: HeadToolMode;
  index: number; // 0 for spindle/saw, 1..14 for top vertical drills, 1..6 for side horizontal drills
  label: string;
}

export interface ToolpathSegment {
  start: Vec3;
  end: Vec3;
  type: MoveType;
  feedrate: number;
  lineNumber: number;
  spindleRpm: number;
  toolCode?: number; // T0 spindle, T1-T14 top drills, T21-T26 side drills, T30 saw
}

export interface ParsedGCode {
  segments: ToolpathSegment[];
  lines: string[];
  bounds: {
    min: Vec3;
    max: Vec3;
  };
  totalLengthMm: number;
  cutLengthMm: number;
  rapidLengthMm: number;
  estimatedTimeSec: number;
}

export interface LiveTraceSegment {
  start: Vec3; // Machine coordinates
  end: Vec3;   // Machine coordinates
  type: MoveType;
  spindleRpm: number;
}

export interface MachineConfig {
  name: string;
  moonrakerUrl: string;
  axisBounds: AxisBounds; // SCM Tech 99L: X[-500..3000], Y[-1000..500], Z[-10..180]
  spindleMaxRpm: number;
  spindleOutputPin: string;
  defaultRapidFeed: number; // mm/min
  defaultCutFeed: number;   // mm/min
  probePlateThickness: number;
  stockEnabled: boolean;
  stockSize: Vec3; // Quadrant 4 panel: +X width, -Y depth, +Z thickness
}

export type ConnectionMode = 'emulator' | 'moonraker';
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type MachineState = 'ready' | 'running' | 'paused' | 'homed' | 'estop' | 'offline';

export interface KlipperTelemetry {
  connectionMode: ConnectionMode;
  connectionStatus: ConnectionStatus;
  statusMessage: string;
  machineState: MachineState;
  homedAxes: { x: boolean; y: boolean; z: boolean };
  machinePos: Vec3;
  workPos: Vec3;
  activeWcs: WcsName;
  wcsOffsets: WcsOffsetMap;
  liveVelocity: number; // mm/min
  feedrateOverride: number; // percent (10..200)
  spindleRpm: number;
  spindleTargetRpm: number;
  spindleOverride: number; // percent (50..150)
  activeTool: ActiveHeadTool;
  activeLineIndex: number;
  jobProgress: number; // 0..1
  jobFilename: string | null;
  jobElapsedSec: number;
  isJobRunning: boolean;
  isJobPaused: boolean;
  klipperVersion: string;
}

export interface ConsoleEntry {
  id: string;
  timestamp: string;
  direction: 'tx' | 'rx' | 'info' | 'error';
  text: string;
}

export interface GCodeFileItem {
  name: string;
  sizeBytes: number;
  modified: string;
  source: 'sample' | 'local' | 'moonraker';
  content?: string;
}

export type ActiveTab = 'dashboard' | 'files' | 'console' | 'config';

export type CameraPreset = 'iso' | 'top' | 'front' | 'side' | 'fit';
