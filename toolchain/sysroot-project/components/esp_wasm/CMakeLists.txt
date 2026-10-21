# Glue between the browser build and the Arduino core:
#  weak_setup_loop.cpp  lets plain ESP-IDF programs (app_main) link
#  hwcdc_serial.cpp     Serial over native USB, chosen per sketch
#  usb_cdc_serial.cpp   the same over TinyUSB's CDC port (USB-OTG variant), started before setup()
#  Kconfig              switches for Arduino libraries the core forgot to declare
idf_component_register(SRCS "weak_setup_loop.cpp" "hwcdc_serial.cpp" "usb_cdc_serial.cpp" PRIV_REQUIRES arduino)
