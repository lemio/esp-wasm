# This component is replaced by the user's objects at link time (@OBJECTS@).
# Its sources exist only so compile_commands.json records the C and C++ flags
# (including every library's include dir), and so the linker keeps the same
# set of components.
# the USB-OTG variant: TinyUSB is part of the sketch's world too (its headers, through USB.h)
set(usb_components "")
if(DEFINED ENV{ESP_WASM_USB})
  set(usb_components arduino_tinyusb)
endif()
file(GLOB arduino_libs LIST_DIRECTORIES true RELATIVE "${CMAKE_CURRENT_LIST_DIR}/../../out/components"
     "${CMAKE_CURRENT_LIST_DIR}/../../out/components/lib_*")
idf_component_register(
    SRCS "main.c" "cxx_stub.cpp"
    # The user's code sees the same headers as in the Arduino IDE: the core,
    # the libraries, and the commonly used parts of ESP-IDF.
    PRIV_REQUIRES arduino esp_wasm ${arduino_libs}
                  esp_wifi esp_netif esp_event lwip esp_http_server esp_http_client mbedtls
                  nvs_flash esp_timer bt driver esp_driver_gpio esp_driver_rmt esp_driver_spi
                  esp_driver_i2c esp_driver_ledc esp_driver_uart esp_driver_mcpwm esp_driver_i2s
                  esp_driver_pcnt esp_adc esp_lcd esp_mm
                  # WiFi.h includes its header (CONFIG_NETWORK_PROV_NETWORK_TYPE_WIFI)
                  espressif__network_provisioning
                  ${usb_components}
)
