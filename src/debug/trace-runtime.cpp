// esp-wasm debug runtime. Compiled into "Trace" builds next to the user's code,
// which calls __sanitizer_cov_trace_pc() at the start of every basic block
// (clang -fsanitize-coverage=trace-pc) and every statement line (inserted by
// src/debug/statement-hooks.ts). This file itself is not instrumented.
//
// Reporting: the hook records where it was called from; a task sends markers
// as APC escape sequences (ESC _ esp-wasm:<key>=<value> ESC \), which the web
// app hides from the output and maps to lines with the build's DWARF line table:
//   boot=debug|trace   at start (debug: takes commands); then hello=… every 5 s
//   pc=XXXXXXXX        the latest address, 20 times a second while running
//   hits=A,B,…         every distinct address that ran in the last 100 ms (a trail)
//   stop=XXXXXXXX      stopped there (pause, step, breakpoint)
//   run=XXXXXXXX       resumed
//
// Debugging (Arduino sketches): the web app sends commands over Serial, in the
// same framing. When the hook decides to stop (pause, step, breakpoint), it
// blocks the calling task in place; the rest of the system keeps running.
//   p             pause
//   c R           continue (R: ranges of the current line, so a breakpoint there doesn't refire at once)
//   i R / o R     step into / over (R: ranges of the current line)
//   u             step out
//   b R           set the breakpoints (all of them)
// R is a comma-separated list of hex address ranges "start-end" (end exclusive).
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "esp_attr.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#if ESP_WASM_ARDUINO
#include <Arduino.h>
#endif

namespace {

struct Range {
  uint32_t start, end;
};

constexpr int MAX_RANGES = 64;

struct RangeSet {
  Range r[MAX_RANGES];
  volatile int n = 0;
  bool contains(uint32_t pc) const {
    for (int k = 0; k < n; k++) {
      if (pc >= r[k].start && pc < r[k].end) return true;
    }
    return false;
  }
};

enum Mode : int { RUN, PAUSE_REQUESTED, STEP_INTO, STEP_OVER, STEP_OUT, STOPPED };

volatile uint32_t s_pc;

// Trail: the distinct addresses that ran since the last report, in a small
// lossy hash table (a collision overwrites; a hot address soon comes back).
// Two tables: the hook fills one while the reporter drains the other.
constexpr int HIT_SLOTS = 64;  // power of 2
constexpr int MAX_HITS_REPORTED = 48;
volatile uint32_t s_hits[2][HIT_SLOTS];
volatile int s_hitTable = 0;

inline IRAM_ATTR void recordHit(uint32_t pc) {
  volatile uint32_t *t = s_hits[s_hitTable];
  uint32_t i = ((pc >> 1) ^ (pc >> 7)) & (HIT_SLOTS - 1);
  if (t[i] != pc) t[i] = pc;
}

void reportHits() {
  int full = s_hitTable;
  s_hitTable = full ^ 1;  // the hook writes to the other table from now on
  vTaskDelay(1);          // let a hook still writing to the old one finish
  volatile uint32_t *t = s_hits[full];
  char buf[32 + MAX_HITS_REPORTED * 9];
  int len = snprintf(buf, sizeof buf, "\x1b_esp-wasm:hits=");
  int n = 0;
  for (int i = 0; i < HIT_SLOTS; i++) {
    uint32_t pc = t[i];
    if (!pc) continue;
    t[i] = 0;
    if (n++ < MAX_HITS_REPORTED) len += snprintf(buf + len, sizeof buf - len, n > 1 ? ",%lx" : "%lx", (unsigned long)pc);
  }
  if (n == 0) return;
  snprintf(buf + len, sizeof buf - len, "\x1b\\");
  printf("%s", buf);
  fflush(stdout);
}
volatile int s_mode = RUN;
volatile bool s_debugging = false;  // anything besides RUN without breakpoints: take the slow path
RangeSet s_breakpoints;
RangeSet s_line;  // the current line while stepping, or the line to leave before breakpoints count again
volatile bool s_skipLine = false;
TaskHandle_t s_stepTask;
uint32_t s_stepSp;
uint32_t s_stopSp;
TaskHandle_t s_stopTask;

void updateDebugging() {
  s_debugging = s_mode != RUN || s_breakpoints.n > 0 || s_skipLine;
}

// The hook's own stack pointer. Its frame size is fixed, so comparing it across
// calls compares the caller's depth (the stack grows down).
inline uint32_t stackPointer() {
#ifdef __XTENSA__
  uint32_t sp;
  __asm__ volatile("mov %0, a1" : "=r"(sp));
  return sp;
#else
  return (uint32_t)(uintptr_t)__builtin_frame_address(0);  // host-side tests
#endif
}

void marker(const char *what, uint32_t pc) {
  printf("\x1b_esp-wasm:%s=%08lx\x1b\\", what, (unsigned long)pc);
  fflush(stdout);
}

// Slow path: decide whether to stop here, and wait while stopped.
void check(uint32_t pc, uint32_t sp) {
  if (xTaskGetSchedulerState() != taskSCHEDULER_RUNNING) return;
  TaskHandle_t me = xTaskGetCurrentTaskHandle();
  // pc is a return address, just after the 3-byte call to the hook. Compare the
  // call itself: if the hook is a line's last instruction, pc is already in the next line.
  const uint32_t at = pc - 3;
  bool stop = false;
  switch (s_mode) {
    case PAUSE_REQUESTED: stop = true; break;
    case STEP_INTO: stop = me == s_stepTask && !s_line.contains(at); break;
    // The stack grows down: a smaller sp is a deeper call.
    case STEP_OVER: stop = me == s_stepTask && sp >= s_stepSp && !s_line.contains(at); break;
    case STEP_OUT: stop = me == s_stepTask && sp > s_stepSp; break;
    default: break;
  }
  if (s_skipLine && !s_line.contains(at)) {
    s_skipLine = false;  // left the line we continued from
    updateDebugging();
  }
  // A breakpoint on the line being stepped or continued from doesn't fire again
  // until execution has left that line.
  const bool onStartLine = (s_skipLine || s_mode == STEP_INTO || s_mode == STEP_OVER) && s_line.contains(at);
  if (!stop && s_breakpoints.n > 0 && !onStartLine) stop = s_breakpoints.contains(at);
  if (!stop) return;

  s_mode = STOPPED;
  s_stopTask = me;
  s_stopSp = sp;
  s_pc = pc;
  updateDebugging();
  marker("stop", pc);
  while (s_mode == STOPPED) vTaskDelay(pdMS_TO_TICKS(5));
}

#if ESP_WASM_ARDUINO
uint32_t parseHex(const char *&p) {
  uint32_t v = 0;
  for (;; p++) {
    char c = *p;
    if (c >= '0' && c <= '9') v = v * 16 + (c - '0');
    else if (c >= 'a' && c <= 'f') v = v * 16 + (c - 'a' + 10);
    else return v;
  }
}

void parseRanges(const char *p, RangeSet &set) {
  set.n = 0;
  int n = 0;
  while (*p == ' ') p++;
  while (*p && n < MAX_RANGES) {
    uint32_t a = parseHex(p);
    if (*p != '-') break;
    p++;
    uint32_t b = parseHex(p);
    set.r[n++] = {a, b};
    if (*p != ',') break;
    p++;
  }
  set.n = n;  // publish after the entries are written
}

void command(const char *cmd) {
  char op = cmd[0];
  const char *args = cmd + 1;
  if (op == 'p') {
    if (s_mode == RUN) s_mode = PAUSE_REQUESTED;
  } else if (op == 'b') {
    parseRanges(args, s_breakpoints);
  } else if (s_mode == STOPPED && (op == 'c' || op == 'i' || op == 'o' || op == 'u')) {
    s_stepTask = s_stopTask;
    s_stepSp = s_stopSp;
    if (op != 'u') parseRanges(args, s_line);
    else s_line.n = 0;
    s_skipLine = op == 'c';
    s_mode = op == 'c' ? RUN : op == 'i' ? STEP_INTO : op == 'o' ? STEP_OVER : STEP_OUT;
    marker("run", s_pc);
  }
  updateDebugging();
}

// Commands arrive framed as ESC _ esp-wasm: <cmd> ESC \ ; anything else is ignored.
void readCommands() {
  static char buf[1400];
  static int len = 0;
  static bool inFrame = false;
  while (Serial.available()) {
    int c = Serial.read();
    if (c < 0) break;
    if (!inFrame) {
      static int esc = 0;
      esc = (c == 0x1b) ? 1 : (esc == 1 && c == '_') ? 2 : 0;
      if (esc == 2) { inFrame = true; len = 0; esc = 0; }
      continue;
    }
    if (c == '\\' && len > 0 && buf[len - 1] == 0x1b) {
      buf[len - 1] = 0;
      if (strncmp(buf, "esp-wasm:", 9) == 0) command(buf + 9);
      inFrame = false;
    } else if (len < (int)sizeof(buf) - 1) {
      buf[len++] = (char)c;
    } else {
      inFrame = false;  // oversized: drop
    }
  }
}
#endif

void reporter(void *) {
#if ESP_WASM_ARDUINO
  const char *hello = "debug";  // takes commands
  vTaskDelay(pdMS_TO_TICKS(500));  // let setup() call Serial.begin() first
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
  Serial.begin(115200);  // native USB: "if (Serial)" means "host connected"; begin() is safe to repeat
#else
  if (!Serial) Serial.begin(115200);  // UART: true once the driver is installed
#endif
#else
  const char *hello = "trace";  // reports only
#endif
  uint32_t last = 0;
  TickType_t sent = 0;
  for (int tick = 0;; tick++) {
    vTaskDelay(pdMS_TO_TICKS(10));
#if ESP_WASM_ARDUINO
    readCommands();
#endif
    // Say what this build can do, now and every 5 s, so a monitor opened later finds out too.
    // "boot" the first time (the page then resends breakpoints), "hello" after that.
    if (tick % 500 == 0) {
      printf("\x1b_esp-wasm:%s=%s\x1b\\", tick ? "hello" : "boot", hello);
      fflush(stdout);
    }
    if (s_mode == STOPPED) continue;
    if (tick % 10 == 0) reportHits();  // the trail, every 100 ms
    if (tick % 5) continue;  // the current address, every 50 ms
    uint32_t pc = s_pc;
    TickType_t now = xTaskGetTickCount();
    // Report changes, and repeat once a second so a newly opened monitor catches up.
    if (pc && (pc != last || now - sent >= pdMS_TO_TICKS(1000))) {
      marker("pc", pc);
      last = pc;
      sent = now;
    }
  }
}

}  // namespace

// IRAM: user ISRs (IRAM_ATTR) are instrumented too, and may run with the flash cache off.
extern "C" IRAM_ATTR void __sanitizer_cov_trace_pc(void) {
  uint32_t ra = (uint32_t)(uintptr_t)__builtin_return_address(0);
  // Xtensa windowed ABI: the top 2 bits of a return address hold the caller's
  // window size. Code lives in 0x40000000–0x7fffffff, so restore them as 01.
  uint32_t pc = (ra & 0x3fffffffu) | 0x40000000u;
  // Never stop in an interrupt; check() is in flash, which may be off here.
  recordHit(pc);
  if (!s_debugging || xPortInIsrContext()) {
    s_pc = pc;
    return;
  }
  check(pc, stackPointer());
  if (s_mode != STOPPED) s_pc = pc;
}

// Runs before app_main()/setup(); the task starts with the scheduler.
__attribute__((constructor)) static void esp_wasm_start_reporter() {
  xTaskCreatePinnedToCore(reporter, "esp-wasm-debug", 4096, nullptr, 2, nullptr, tskNO_AFFINITY);
}
