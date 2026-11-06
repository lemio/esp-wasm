// Platform glue that funprog expects (see ch32fun's
// minichlink/funprog/funprog_port_example.h), for the ESP32-S3.
#ifndef FUNPROG_PORT_H
#define FUNPROG_PORT_H

#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include "esp_attr.h"
#include "esp_rom_sys.h"
#include "driver/gpio.h"
#include "soc/gpio_struct.h"
#include "freertos/FreeRTOS.h"

#if SWIO_PIN > 31 || SWCLK_PIN > 31
#error "SWIO_PIN and SWCLK_PIN must be GPIO 0..31"
#endif

#if DEBUG_PRINT
#define FUN_PRINTF_DEBUG(format, args...) printf(format, ##args)
#else
#define FUN_PRINTF_DEBUG(format, args...)
#endif

#if STATUS_LED_PIN >= 0
#define STATUS_LED_ON  gpio_set_level((gpio_num_t)STATUS_LED_PIN, 1)
#define STATUS_LED_OFF gpio_set_level((gpio_num_t)STATUS_LED_PIN, 0)
#else
#define STATUS_LED_ON
#define STATUS_LED_OFF
#endif

void funprog_power(int on);
void funprog_setup_pins(void);
#define POWER_SETUP funprog_setup_pins()
#define POWER_ON    funprog_power(1)
#define POWER_OFF   funprog_power(0)

#define DELAY_US(n) esp_rom_delay_us(n)
#define DELAY_MS(n) esp_rom_delay_us((n) * 1000)

// CH59x parts need slower bits (funprog_logic.h uses the global `state`).
#define SLOW_DOWN_PROTOCOL do { if (state.t1coeff < 12) state.t1coeff = 12; } while (0)

// The bit-banging runs from IRAM, so flash cache misses don't stretch the bits.
#define IRAM IRAM_ATTR

#endif
