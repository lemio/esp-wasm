/**
 * Boards an embedded project can target. All are ESP32-S3s built against the same sysroot
 * (the generic esp32s3 variant); a board only adds the few definitions that differ.
 */
export interface Board {
  name: string;
  /** Included right after Arduino.h (see BuildOptions.boardHeader). */
  header?: string;
}

export const BOARDS: Record<string, Board> = {
  "esp32-s3": { name: "ESP32-S3" },
  schematik: {
    name: "Schematik",
    // The generic variant's LED_BUILTIN is an RGB LED on GPIO48; on Schematik the plain
    // on/off light is the blue status LED on GPIO40 (via Q1), and the RGB LED is on GPIO13.
    header: [
      "#pragma once",
      "#undef LED_BUILTIN",
      "#define LED_BUILTIN 40",
      "#undef RGB_BUILTIN",
      "#define RGB_BUILTIN (SOC_GPIO_PIN_COUNT + 13)",
      "",
    ].join("\n"),
  },
};

export const boardFor = (id: string | null): Board => BOARDS[(id ?? "").toLowerCase()] ?? BOARDS["esp32-s3"];
