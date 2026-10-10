// Starter code per project type. Mirrors examples/neopixel/neopixel.ino and
// examples/blink/main.c.

export const ARDUINO_SOURCE = `// Groetjes van Geert
// Rainbow on a NeoPixel (WS2812) LED. The ESP32-S3-DevKitC-1 has one on board:
// GPIO38 on v1.1 boards, GPIO48 on v1.0.
#include <Adafruit_NeoPixel.h>

#define LED_PIN    38
#define LED_COUNT  1

Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  pixels.begin();
  pixels.setBrightness(40);
  Serial.println("Hello from esp-wasm!");
}

void loop() {
  static uint16_t hue = 0;
  pixels.setPixelColor(0, pixels.gamma32(pixels.ColorHSV(hue)));
  pixels.show();
  if (hue % 16384 == 0) Serial.printf("hue %u\\n", hue);
  hue += 256;
  delay(20);
}
`;

export const IDF_SOURCE = `#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

// Groetjes van Geert
// Blinks GPIO38. Wire an LED (with a resistor) to it, or change the pin here.
#define LED_GPIO GPIO_NUM_38

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);

    int on = 0;
    while (1) {
        on = !on;
        gpio_set_level(LED_GPIO, on);
        printf("LED %s\\n", on ? "on" : "off");
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
`;
