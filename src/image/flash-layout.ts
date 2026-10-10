/** Default ESP-IDF flash layout for the ESP32-S3 (single-app partition table). */
export const FLASH_OFFSETS = {
  bootloader: 0x0000, // 0x1000 on the original ESP32, 0x0 on the S3
  partitionTable: 0x8000,
  app: 0x10000,
} as const;
