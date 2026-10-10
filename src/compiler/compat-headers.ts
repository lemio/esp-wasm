/**
 * Stand-ins for ESP-IDF headers that ESP-IDF 6 removed but older Arduino
 * libraries still include (often without using them). They're on the include
 * path after everything else (-idirafter), so a real header always wins.
 * A library that actually calls the old API fails with "undeclared …" instead
 * of a missing file.
 */
export const COMPAT_DIR = "/compat";

export const COMPAT_HEADERS: Record<string, string> = {
  "driver/adc.h": `#pragma once
// esp-wasm stand-in: ESP-IDF 6 removed the legacy ADC driver (driver/adc.h).
// Use the oneshot/continuous drivers instead; this only provides their types.
#warning "driver/adc.h was removed in ESP-IDF 6; esp-wasm provides an empty stand-in (the legacy adc1_*/adc2_* functions don't exist)"
#include "esp_adc/adc_oneshot.h"
`,
};
