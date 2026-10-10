// Groetjes van Geert
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
  if (hue % 16384 == 0) Serial.printf("hue %u\n", hue);
  hue += 256;
  delay(20);
}
