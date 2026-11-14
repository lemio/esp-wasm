// Starter code per project type. Mirrors examples/neopixel/neopixel.ino and
// examples/blink/main.c.

export const ARDUINO_SOURCE = `
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

export const CH32V003_SOURCE = `// Blink on a CH32V003 with ch32fun (https://github.com/cnlohr/ch32fun).
// PD6 is the LED on many CH32V003 boards (the WCH CH32V003F4P6-EVT has it on PD0).
#include "ch32fun.h"

#ifdef CH32X035
#define LED_PIN PA0 // the CH32X035 has no port D
#else
#define LED_PIN PD6
#endif

int main()
{
	SystemInit();
	funGpioInitAll();
	funPinMode(LED_PIN, GPIO_Speed_10MHz | GPIO_CNF_OUT_PP);

	while (1)
	{
		funDigitalWrite(LED_PIN, FUN_HIGH);
		Delay_Ms(250);
		funDigitalWrite(LED_PIN, FUN_LOW);
		Delay_Ms(250);
	}
}
`;

export const CH32V003_ARDUINO_SOURCE = `// Blink on a CH32V003 with WCH's Arduino core (https://github.com/openwch/arduino_core_ch32).
// The WCH CH32V003F4P6-EVT has its LED on PD0 (change LED_PIN for your board, but not to
// PD5/PD6: they're Serial's TX and RX, e.g. to the board's USB-serial chip).
#ifdef CH32X035
#define LED_PIN PA0 // the CH32X035 has no port D
#else
#define LED_PIN PD0
#endif

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(250);
  digitalWrite(LED_PIN, LOW);
  delay(250);
  Serial.println(millis());
}
`;
