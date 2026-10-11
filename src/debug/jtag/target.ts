/** What the inspector needs from a chip, independent of how it's reached. */
export interface Registers {
  pc: number;
  /** a0–a15 of the current register window. */
  ar: number[];
}

/** Why the current core stopped. */
export type StopCause = "breakpoint" | "watchpoint" | "step" | "pause" | "crash" | "unknown";

export interface DebugTarget {
  readonly name: string;
  /** Verbose log of everything exchanged with the chip. */
  setTrace(trace: ((line: string) => void) | undefined): void;
  /** The link to the chip is gone for good (unplugged, re-enumerated); the target can't be used any more. */
  onLost?: (reason: string) => void;
  /** The chip reset by itself while connected (watchdog, panic, reset button); breakpoints need programming again. */
  onReset?: () => void;
  /** `quiet`: only a device the page was allowed before; never show the browser's picker. */
  connect(quiet?: boolean): Promise<void>;
  disconnect(): Promise<void>;
  /** CPU cores; they stop and start together. */
  readonly coreCount: number;
  /** The core that register reads and steps act on. */
  readonly core: number;
  selectCore(i: number): void;
  /** The core that stopped first by itself (breakpoint, crash) in the latest stop, if it wasn't a pause. */
  readonly stoppedCore?: number;
  isHalted(): Promise<boolean>;
  halt(): Promise<void>;
  resume(): Promise<void>;
  /** While paused: whether the chip was reset meanwhile (a reset button, say). It runs again then. */
  checkRestarted(): Promise<boolean>;
  /** Restart the whole chip (as after power-up, but the USB connection stays); it runs afterwards. */
  restartChip(): Promise<void>;
  /** Execute one instruction on the current core and halt again. */
  stepInstruction(): Promise<void>;
  /** Why the current core is stopped. */
  stopCause(): Promise<StopCause>;
  readRegisters(): Promise<Registers>;
  /** The current core's cycle counter (CCOUNT): 32 bits, counting CPU clock cycles. */
  readCycleCount(): Promise<number>;
  /** Just the program counter (cheaper than readRegisters, for stepping). */
  readPc(): Promise<number>;
  /**
   * The stack frames from the innermost outwards: the PC each is executing (for callers, the return
   * address) and its stack pointer. The CPU must be halted.
   */
  readFrames(max: number): Promise<{ pc: number; sp: number }[]>;
  readMemory(addr: number, length: number): Promise<Uint8Array>;
  writeMemory(addr: number, data: Uint8Array): Promise<void>;
  /** Hardware breakpoints (the S3 has two per core); applied on the next resume or step. */
  setBreakpoints(addrs: number[]): void;
}
