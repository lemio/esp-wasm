// The Arduino component links with "-u setup -u loop" (CONFIG_AUTOSTART_ARDUINO).
// An Arduino sketch defines both, and its objects come first in the link, so
// these weak stubs are never pulled in. A plain ESP-IDF program defines
// app_main instead; then these stubs satisfy the -u references and the
// Arduino core's own app_main is never linked.
__attribute__((weak)) void setup() {}
__attribute__((weak)) void loop() {}
