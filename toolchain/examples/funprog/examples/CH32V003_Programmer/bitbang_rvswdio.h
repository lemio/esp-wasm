// Low-level RVSWIO (single wire, CH32V003) and RVSWD (two wire) bit-banging
// for the ESP32-S3: the functions funprog_rvswdio.h declares.
//
// Ported from the ESP32-S2 programmer in https://github.com/cnlohr/esp32s2-cookbook
// (ch32v003programmer/main/bitbang_rvswdio.h), Copyright 2023-2024 <>< Charles Lohr,
// MIT/x11 or NewBSD licensed. The ESP32-S3 has the same Xtensa LX7 core and GPIO
// set/clear registers, so the timing loops carry over.
//
// All bit functions assume the bus idles with the data line driven high:
//   GPIO.out_w1ts = pinmask; GPIO.enable_w1ts = pinmask;

#ifndef BITBANG_RVSWDIO_H
#define BITBANG_RVSWDIO_H

// Interrupts stay off for one register transfer (~100 us) so bits keep their width.
static uint32_t bb_isr_state;
#define DisableISR() (bb_isr_state = portSET_INTERRUPT_MASK_FROM_ISR())
#define EnableISR()  portCLEAR_INTERRUPT_MASK_FROM_ISR(bb_isr_state)

static inline void PrecDelay(int delay)
{
	asm volatile(
	"1: addi %[delay], %[delay], -1\n"
	"   bbci %[delay], 31, 1b\n" : [delay]"+r"(delay));
}

static inline void Send1BitSWIO(struct SWIOState * state)
{
	// Low for a nominal period of time, then high for a nominal period of time.
	GPIO.out_w1tc = state->pinmaskD;
	PrecDelay(state->t1coeff);
	GPIO.out_w1ts = state->pinmaskD;
	PrecDelay(state->t1coeff);
}

static inline void Send0BitSWIO(struct SWIOState * state)
{
	// Low for a long period of time, then high for a nominal period of time.
	GPIO.out_w1tc = state->pinmaskD;
	PrecDelay(state->t1coeff * 4);
	GPIO.out_w1ts = state->pinmaskD;
	PrecDelay(state->t1coeff);
}

// Returns 0 or 1 for the bit, 2 on timeout.
static inline int ReadBitSWIO(struct SWIOState * state)
{
	int t1coeff = state->t1coeff;
	int pinmaskD = state->pinmaskD;
	int medwait = t1coeff * 2;
	int ret;

	// Drive low very briefly, let it float high, and see if the target holds it low.
	GPIO.out_w1tc = pinmaskD;
	PrecDelay(t1coeff);
	GPIO.enable_w1tc = pinmaskD;
	GPIO.out_w1ts = pinmaskD;
#ifdef R_GLITCH_HIGH
	int halfwait = t1coeff / 2;
	PrecDelay(halfwait);
	GPIO.enable_w1ts = pinmaskD;
	GPIO.enable_w1tc = pinmaskD;
	PrecDelay(halfwait);
#else
	PrecDelay(medwait);
#endif
	ret = GPIO.in;

#ifdef R_GLITCH_HIGH
	if (!(ret & pinmaskD))
	{
		// Still low: wait, then glitch it high again.
		PrecDelay(medwait);
		GPIO.enable_w1ts = pinmaskD;
		GPIO.enable_w1tc = pinmaskD;
	}
#endif
	for (int timeout = 0; timeout < MAX_IN_TIMEOUT; timeout++)
	{
		if (GPIO.in & pinmaskD)
		{
			GPIO.enable_w1ts = pinmaskD;
			PrecDelay(t1coeff / 2);
			return !!(ret & pinmaskD);
		}
	}

	// Force it high anyway so that, though hazarded, we can move along.
	GPIO.enable_w1ts = pinmaskD;
	return 2;
}

static inline void SendBitRVSWD(struct SWIOState * state, int val)
{
	// SWD in an indeterminate state, SWC high.
	GPIO.out_w1tc = state->pinmaskC;
	if (val)
		GPIO.out_w1ts = state->pinmaskD;
	else
		GPIO.out_w1tc = state->pinmaskD;
	GPIO.enable_w1ts = state->pinmaskD;
	PrecDelay(state->t1coeff);
	GPIO.out_w1ts = state->pinmaskC;
	PrecDelay(state->t1coeff);
}

static inline int ReadBitRVSWD(struct SWIOState * state)
{
	GPIO.enable_w1tc = state->pinmaskD;
	GPIO.out_w1tc = state->pinmaskC;
	GPIO.out_w1ts = state->pinmaskD;
	PrecDelay(state->t1coeff);
	int r = !!(GPIO.in & state->pinmaskD);
	GPIO.out_w1ts = state->pinmaskC;
	PrecDelay(state->t1coeff);
	return r;
}

static inline void RVSWDStop(struct SWIOState * state)
{
	GPIO.out_w1tc = state->pinmaskC;
	PrecDelay(state->t1coeff);
	GPIO.out_w1tc = state->pinmaskD;
	GPIO.enable_w1ts = state->pinmaskD;
	PrecDelay(state->t1coeff);
	GPIO.out_w1ts = state->pinmaskC;
	PrecDelay(state->t1coeff);
	GPIO.out_w1ts = state->pinmaskD;
}

static inline void BusIdle(struct SWIOState * state)
{
	GPIO.out_w1ts = state->pinmaskC;
	GPIO.enable_w1ts = state->pinmaskC;
	GPIO.out_w1ts = state->pinmaskD;
	GPIO.enable_w1ts = state->pinmaskD;
}

static void MCFWriteReg32(struct SWIOState * state, uint8_t command, uint32_t value)
{
	uint32_t mask;
	BusIdle(state);
	if (state->opmode == 1)
	{
		DisableISR();
		Send1BitSWIO(state);
		for (mask = 1 << 6; mask; mask >>= 1)
		{
			if (command & mask) Send1BitSWIO(state);
			else Send0BitSWIO(state);
		}
		Send1BitSWIO(state); // Write
		for (mask = 1u << 31; mask; mask >>= 1)
		{
			if (value & mask) Send1BitSWIO(state);
			else Send0BitSWIO(state);
		}
		EnableISR();
		esp_rom_delay_us(8); // Sometimes 2 is too short.
	}
	else if (state->opmode == 2)
	{
		DisableISR();
		GPIO.out_w1tc = state->pinmaskD;
		PrecDelay(state->t1coeff);
		int parity = 1;
		for (mask = 1 << 6; mask; mask >>= 1)
		{
			int v = !!(command & mask);
			parity ^= v;
			SendBitRVSWD(state, v);
		}
		SendBitRVSWD(state, 1); // Write = high
		SendBitRVSWD(state, parity);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		SendBitRVSWD(state, 0); // 0 for register, 1 for value.
		SendBitRVSWD(state, 0);

		parity = 0;
		for (mask = 1u << 31; mask; mask >>= 1)
		{
			int v = !!(value & mask);
			parity ^= v;
			SendBitRVSWD(state, v);
		}
		SendBitRVSWD(state, parity);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		SendBitRVSWD(state, 1); // 0 for register, 1 for value.
		SendBitRVSWD(state, 0);
		RVSWDStop(state);
		EnableISR();
		esp_rom_delay_us(8);
	}
}

// Returns 0 if no error, otherwise an error code.
static int MCFReadReg32(struct SWIOState * state, uint8_t command, uint32_t * value)
{
	uint32_t mask;
	uint32_t rval = 0;
	BusIdle(state);
	if (state->opmode == 1)
	{
		DisableISR();
		Send1BitSWIO(state);
		for (mask = 1 << 6; mask; mask >>= 1)
		{
			if (command & mask) Send1BitSWIO(state);
			else Send0BitSWIO(state);
		}
		Send0BitSWIO(state); // Read
		for (int i = 0; i < 32; i++)
		{
			rval <<= 1;
			int r = ReadBitSWIO(state);
			if (r == 1) rval |= 1;
			if (r == 2)
			{
				EnableISR();
				return -21;
			}
		}
		*value = rval;
		EnableISR();
		esp_rom_delay_us(8);
	}
	else if (state->opmode == 2)
	{
		DisableISR();
		GPIO.out_w1tc = state->pinmaskD;
		PrecDelay(state->t1coeff);
		int parity = 0;
		for (mask = 1 << 6; mask; mask >>= 1)
		{
			int v = !!(command & mask);
			parity ^= v;
			SendBitRVSWD(state, v);
		}
		SendBitRVSWD(state, 0); // Read = low
		SendBitRVSWD(state, parity);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		SendBitRVSWD(state, 0); // 0 for register, 1 for value
		SendBitRVSWD(state, 0);

		parity = 0;
		for (int i = 0; i < 32; i++)
		{
			rval <<= 1;
			if (ReadBitRVSWD(state))
			{
				rval |= 1;
				parity ^= 1;
			}
		}
		*value = rval;

		if (ReadBitRVSWD(state) != parity)
		{
			EnableISR();
			return -23;
		}
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		ReadBitRVSWD(state);
		SendBitRVSWD(state, 1); // 1 for data
		SendBitRVSWD(state, 0);
		RVSWDStop(state);
		EnableISR();
		esp_rom_delay_us(8);
	}
	else
	{
		return -2;
	}
	return 0;
}

static inline void ConfigureIOForRVSWIO(struct SWIOState * state)
{
	GPIO.out_w1ts = state->pinmaskD;
	GPIO.enable_w1ts = state->pinmaskD;
}

static inline void ConfigureIOForRVSWD(struct SWIOState * state)
{
	BusIdle(state);
}

#endif
