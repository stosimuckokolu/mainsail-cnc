import { GCodeFileItem } from '../types/cnc';

export interface MoonrakerStatusPayload {
  toolhead?: {
    homed_axes?: string;
    position?: [number, number, number, number?];
    max_velocity?: number;
  };
  gcode_move?: {
    gcode_position?: [number, number, number, number?];
    position?: [number, number, number, number?];
    homing_origin?: [number, number, number, number?];
    speed?: number;
    speed_factor?: number;
  };
  motion_report?: {
    live_position?: [number, number, number, number?];
    live_velocity?: number;
  };
  virtual_sdcard?: {
    is_active?: boolean;
    progress?: number;
    file_position?: number;
    file_path?: string | null;
  };
  print_stats?: {
    state?: string;
    filename?: string;
    print_duration?: number;
    message?: string;
  };
  webhooks?: {
    state?: string;
    state_message?: string;
  };
  fan?: {
    speed?: number;
  };
  [key: string]: unknown;
}

export interface MoonrakerCallbacks {
  onStatusChange: (status: 'connecting' | 'connected' | 'disconnected' | 'error', message: string) => void;
  onTelemetryUpdate: (payload: MoonrakerStatusPayload) => void;
  onGcodeResponse: (line: string) => void;
  onPrinterInfo: (info: { softwareVersion: string; state: string; stateMessage: string }) => void;
}

function normalizeHttpBase(rawUrl: string): string {
  let clean = rawUrl.trim();
  if (!clean) clean = 'http://mainsailos.local:7125';
  if (clean.startsWith('ws://')) clean = 'http://' + clean.slice(5);
  else if (clean.startsWith('wss://')) clean = 'https://' + clean.slice(6);
  else if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'http://' + clean;
  }
  // Remove trailing slash or /websocket
  clean = clean.replace(/\/websocket\/?$/, '').replace(/\/+$/, '');
  return clean;
}

function toWebSocketUrl(httpBase: string): string {
  if (httpBase.startsWith('https://')) {
    return 'wss://' + httpBase.slice(8) + '/websocket';
  }
  return 'ws://' + httpBase.slice(7) + '/websocket';
}

export class MoonrakerClient {
  private ws: WebSocket | null = null;
  private httpBase = '';
  private spindleObjectKey = 'output_pin spindle';
  private nextRpcId = 100;
  private pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private callbacks: MoonrakerCallbacks;
  private manualClose = false;

  constructor(callbacks: MoonrakerCallbacks) {
    this.callbacks = callbacks;
  }

  public getHttpBase(): string {
    return this.httpBase;
  }

  public connect(rawUrl: string, spindlePinName = 'spindle'): void {
    this.disconnect();
    this.manualClose = false;
    this.httpBase = normalizeHttpBase(rawUrl);
    this.spindleObjectKey = spindlePinName.includes(' ')
      ? spindlePinName
      : `output_pin ${spindlePinName}`;

    const wsUrl = toWebSocketUrl(this.httpBase);
    this.callbacks.onStatusChange('connecting', `Connecting to ${wsUrl}...`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to open WebSocket';
      this.callbacks.onStatusChange('error', msg);
      return;
    }

    this.ws.onopen = async () => {
      this.callbacks.onStatusChange('connected', `Connected to Moonraker (${this.httpBase})`);
      try {
        const info = (await this.rpc('printer.info')) as {
          software_version?: string;
          state?: string;
          state_message?: string;
        };
        this.callbacks.onPrinterInfo({
          softwareVersion: info?.software_version || 'Klipper',
          state: info?.state || 'ready',
          stateMessage: info?.state_message || 'Printer is ready',
        });

        const subResult = (await this.rpc('printer.objects.subscribe', {
          objects: {
            toolhead: ['homed_axes', 'position', 'max_velocity'],
            gcode_move: ['gcode_position', 'position', 'homing_origin', 'speed', 'speed_factor'],
            motion_report: ['live_position', 'live_velocity'],
            virtual_sdcard: ['is_active', 'progress', 'file_position', 'file_path'],
            print_stats: ['state', 'filename', 'print_duration', 'message'],
            webhooks: ['state', 'state_message'],
            fan: ['speed'],
            [this.spindleObjectKey]: ['value'],
          },
        })) as { status?: MoonrakerStatusPayload };

        if (subResult?.status) {
          this.callbacks.onTelemetryUpdate(subResult.status);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Handshake error';
        this.callbacks.onGcodeResponse(`!! Moonraker handshake error: ${msg}`);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: unknown[];
        };

        if (typeof data.id === 'number' && this.pending.has(data.id)) {
          const entry = this.pending.get(data.id)!;
          this.pending.delete(data.id);
          if (data.error) {
            entry.reject(new Error(data.error.message || 'Moonraker RPC error'));
          } else {
            entry.resolve(data.result);
          }
          return;
        }

        if (data.method === 'notify_status_update' && Array.isArray(data.params)) {
          const status = data.params[0] as MoonrakerStatusPayload | undefined;
          if (status) {
            this.callbacks.onTelemetryUpdate(status);
          }
        } else if (data.method === 'notify_gcode_response' && Array.isArray(data.params)) {
          const line = String(data.params[0] ?? '');
          if (line) {
            this.callbacks.onGcodeResponse(line);
          }
        } else if (data.method === 'notify_klippy_ready') {
          this.callbacks.onStatusChange('connected', 'Klippy ready');
        } else if (data.method === 'notify_klippy_shutdown') {
          this.callbacks.onGcodeResponse('!! Klippy shutdown detected');
        }
      } catch {
        // Ignore malformed frames
      }
    };

    this.ws.onerror = () => {
      const hint =
        window.location.protocol === 'https:' && wsUrl.startsWith('ws://')
          ? 'Browser blocked ws:// from HTTPS origin; configure wss:// reverse proxy or run local.'
          : `Could not reach Moonraker at ${wsUrl}`;
      this.callbacks.onStatusChange('error', hint);
    };

    this.ws.onclose = () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error('WebSocket closed'));
      }
      this.pending.clear();
      if (!this.manualClose) {
        this.callbacks.onStatusChange('disconnected', 'Disconnected from Moonraker');
      }
    };
  }

  public disconnect(): void {
    this.manualClose = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.pending.clear();
  }

  public rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Moonraker WebSocket is not connected'));
        return;
      }
      const id = this.nextRpcId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method,
          params: params ?? {},
          id,
        }),
      );
      window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 10000);
    });
  }

  public async sendGcode(script: string): Promise<void> {
    await this.rpc('printer.gcode.script', { script });
  }

  public async emergencyStop(): Promise<void> {
    await this.rpc('printer.emergency_stop');
  }

  public async firmwareRestart(): Promise<void> {
    await this.rpc('printer.firmware_restart');
  }

  public async pauseJob(): Promise<void> {
    await this.rpc('printer.print.pause');
  }

  public async resumeJob(): Promise<void> {
    await this.rpc('printer.print.resume');
  }

  public async cancelJob(): Promise<void> {
    await this.rpc('printer.print.cancel');
  }

  public async startFile(filename: string): Promise<void> {
    await this.rpc('printer.print.start', { filename });
  }

  public async listGcodeFiles(): Promise<GCodeFileItem[]> {
    const res = (await this.rpc('server.files.list', { root: 'gcodes' })) as Array<{
      path: string;
      size: number;
      modified: number;
    }>;
    if (!Array.isArray(res)) return [];
    return res
      .filter((f) => /\.(nc|gcode|ngc|tap|cnc)$/i.test(f.path))
      .map((f) => ({
        name: f.path,
        sizeBytes: f.size,
        modified: new Date(f.modified * 1000).toISOString().slice(0, 16).replace('T', ' '),
        source: 'moonraker' as const,
      }));
  }

  public async fetchGcodeContent(filename: string): Promise<string> {
    const url = `${this.httpBase}/server/files/gcodes/${encodeURIComponent(filename)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${filename}`);
    }
    return response.text();
  }

  public async uploadGcodeFile(filename: string, content: string, startPrint = false): Promise<void> {
    const form = new FormData();
    const blob = new Blob([content], { type: 'text/plain' });
    form.append('file', blob, filename);
    form.append('root', 'gcodes');
    if (startPrint) {
      form.append('print', 'true');
    }
    const response = await fetch(`${this.httpBase}/server/files/upload`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Upload failed (HTTP ${response.status})`);
    }
  }
}
