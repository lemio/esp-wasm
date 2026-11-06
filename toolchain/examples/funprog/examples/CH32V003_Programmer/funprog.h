// The interface between the sketch (USB HID) and funprog (funprog.c).
#ifndef FUNPROG_H
#define FUNPROG_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Largest feature report minichlink sends (report 0xae: ID + 263 bytes).
#define FUNPROG_REPORT_SIZE 264

/** Sets up the pins and powers the target. */
void funprog_begin(void);
/** Runs the commands in a feature report minichlink sent. report[0] is the report ID. */
void funprog_command(const uint8_t *report, uint16_t len);
/** Fills a feature report minichlink reads: report[0] is the reply length (0xff: not ready yet). */
uint16_t funprog_reply(uint8_t *report, uint16_t len);

#ifdef __cplusplus
}
#endif

#endif
