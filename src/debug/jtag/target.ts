/** What the inspector needs from a chip, independent of how it's reached. */
export interface Registers {
  pc: number;
  /** a0–a15 of the current register window. */
  ar: number[];
}

export interface DebugTarget {
  readonly name: string;
  /** Verbose log of everything exchanged with the chip. */
  setTrace(trace: ((line: string) => void) | undefined): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isHalted(): Promise<boolean>;
  halt(): Promise<void>;
  resume(): Promise<void>;
  /** Execute one instruction and halt again. */
  stepInstruction(): Promise<void>;
  readRegisters(): Promise<Registers>;
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
