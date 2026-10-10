// RMT diagnostics: sends one green pixel on LED_PIN, then prints what the RMT
// peripheral did and which interrupts are installed. Uses printf, which goes to
// ESP-IDF's console on both the UART and the native USB port.
#include <Adafruit_NeoPixel.h>
#include "soc/rmt_struct.h"
#include "soc/system_reg.h"
#include "esp_intr_alloc.h"

#define LED_PIN 38

Adafruit_NeoPixel pixels(1, LED_PIN, NEO_GRB + NEO_KHZ800);

static void dumpRmt(const char *when) {
  printf("\n[%s]\n", when);
  printf("  RMT clock enabled: %s, in reset: %s\n",
         (REG_READ(SYSTEM_PERIP_CLK_EN0_REG) & SYSTEM_RMT_CLK_EN) ? "yes" : "NO",
         (REG_READ(SYSTEM_PERIP_RST_EN0_REG) & SYSTEM_RMT_RST) ? "YES" : "no");
  printf("  sys_conf=%08lx int_raw=%08lx int_st=%08lx int_ena=%08lx\n",
         (unsigned long)RMT.sys_conf.val, (unsigned long)RMT.int_raw.val,
         (unsigned long)RMT.int_st.val, (unsigned long)RMT.int_ena.val);
  for (int ch = 0; ch < 4; ch++) {
    printf("  tx ch%d: conf0=%08lx status=%08lx\n", ch,
           (unsigned long)RMT.chnconf0[ch].val, (unsigned long)RMT.chnstatus[ch].val);
  }
}

void setup() {
  delay(2000);  // time to open the monitor
  printf("\n=== esp-wasm RMT diagnostics (LED on GPIO%d) ===\n", LED_PIN);
  pixels.begin();
  dumpRmt("before show");
  pixels.setPixelColor(0, pixels.Color(0, 40, 0));
  uint32_t t = micros();
  pixels.show();
  printf("\nshow() took %lu us\n", (unsigned long)(micros() - t));
  dumpRmt("after show");
  printf("\nInterrupts:\n");
  esp_intr_dump(stdout);
  printf("=== end ===\n");
}

void loop() {
  delay(1000);
}
