# Template ESP-IDF project. Building it produces the precompiled sysroot the
# browser links user code against: ESP-IDF, the Arduino core (arduino-esp32)
# and the libraries in ../arduino-libraries.txt. Run ../fetch-arduino.sh first.
cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../out/components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Arduino "USB Mode: Hardware CDC and JTAG" (the Arduino IDE default for the S3).
# ARDUINO_USB_CDC_ON_BOOT is left to the browser build: it decides per sketch
# whether Serial is UART0 or the native USB port (see esp_wasm/hwcdc_serial.cpp).
idf_build_set_property(COMPILE_DEFINITIONS "ARDUINO_USB_MODE=1" APPEND)
# C++ exceptions (on in Arduino builds) need an unwinder. esp-clang's libgcc.a
# has one; its default runtime (libclang_rt.builtins) doesn't. -rtlib=libgcc
# makes the clang driver link libgcc last, after libstdc++; --unwindlib=none stops
# it asking for libgcc_s/libgcc_eh, which don't exist here (libgcc.a has the unwinder).
if("$ENV{IDF_TOOLCHAIN}" STREQUAL "clang")
  idf_build_set_property(LINK_OPTIONS "-rtlib=libgcc;--unwindlib=none" APPEND)
endif()
# Only build what main needs (and their dependencies) to keep the sysroot small.
set(COMPONENTS main)
project(esp_wasm_sysroot)

# arduino-esp32 is written for GCC. Clang reports extra warnings there
# (missing 'override', VLAs in C++, …) that IDF's -Werror would turn into errors.
idf_component_get_property(arduino_lib arduino COMPONENT_LIB)
target_compile_options(${arduino_lib} PRIVATE -Wno-error)
