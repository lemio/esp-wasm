#include <stdio.h>
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
        printf("LED %s\n", on ? "on" : "off");
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
