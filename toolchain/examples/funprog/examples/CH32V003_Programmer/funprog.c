// funprog, ch32fun's programmer core, on the ESP32-S3. Includes the funprog
// files in the order minichlink/funprog/README.md asks for.
#include "funprog_config.h"
#include "funprog_port.h"
#include "funprog_rvswdio.h"
#include "bitbang_rvswdio.h"
#include "funprog_logic.h"
#include "funprog.h"

static uint8_t reply[FUNPROG_REPORT_SIZE];
static int reply_ready;

static void pin_setup(int pin, gpio_drive_cap_t drive)
{
	gpio_config_t c = {
		.pin_bit_mask = 1ULL << pin,
		.mode = GPIO_MODE_INPUT_OUTPUT,
		.pull_up_en = GPIO_PULLUP_ENABLE,
		.pull_down_en = GPIO_PULLDOWN_DISABLE,
		.intr_type = GPIO_INTR_DISABLE,
	};
	gpio_config(&c);
	gpio_set_drive_capability((gpio_num_t)pin, drive);
}

void funprog_setup_pins(void)
{
	pin_setup(SWIO_PIN, GPIO_DRIVE_CAP_1);  // ~10 mA, with the internal pull-up
	pin_setup(SWCLK_PIN, GPIO_DRIVE_CAP_1);
}

void funprog_power(int on)
{
	if (on)
	{
#if TARGET_POWER_PIN >= 0
		gpio_set_level((gpio_num_t)TARGET_POWER_PIN, 1);
#endif
		GPIO.out_w1ts = state.pinmaskD;
		GPIO.enable_w1ts = state.pinmaskD | state.pinmaskC;
	}
	else
	{
		// Drive the lines low so the target doesn't stay powered through them.
		GPIO.out_w1tc = state.pinmaskD | state.pinmaskC;
		GPIO.enable_w1ts = state.pinmaskD | state.pinmaskC;
#if TARGET_POWER_PIN >= 0
		gpio_set_level((gpio_num_t)TARGET_POWER_PIN, 0);
#endif
	}
}

void funprog_begin(void)
{
#if STATUS_LED_PIN >= 0
	gpio_reset_pin((gpio_num_t)STATUS_LED_PIN);
	gpio_set_direction((gpio_num_t)STATUS_LED_PIN, GPIO_MODE_OUTPUT);
#endif
#if TARGET_POWER_PIN >= 0
	gpio_reset_pin((gpio_num_t)TARGET_POWER_PIN);
	gpio_set_drive_capability((gpio_num_t)TARGET_POWER_PIN, GPIO_DRIVE_CAP_3);  // ~40 mA
	gpio_set_direction((gpio_num_t)TARGET_POWER_PIN, GPIO_MODE_OUTPUT);
#endif
	memset(&state, 0, sizeof(state));
	state.pinmaskD = 1 << SWIO_PIN;
	state.pinmaskC = 1 << SWCLK_PIN;
	// One PrecDelay() loop is ~2 cycles; 10 works at 240 MHz on the ESP32-S2.
	state.t1coeff = esp_rom_get_cpu_ticks_per_us() / 24;
	if (state.t1coeff < 2) state.t1coeff = 2;
	programmer_mode = 0;

	funprog_setup_pins();
	funprog_power(1);
	esp_rom_delay_us(5000);
}

void funprog_command(const uint8_t *report, uint16_t len)
{
	HandleCommandBuffer((uint8_t *)report, len, reply, sizeof(reply));
	reply_ready = 1;
}

uint16_t funprog_reply(uint8_t *report, uint16_t len)
{
	if (!reply_ready)
	{
		report[0] = 0xff;  // minichlink asks again
		return len;
	}
	reply_ready = 0;
	uint16_t n = reply[0] + 1;
	if (n > len) n = len;
	memcpy(report, reply, n);
	return len;
}
