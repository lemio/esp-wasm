#!/usr/bin/env python3
"""
Generate src/debug/jtag/soc/esp32s3.json: the ESP32-S3's peripheral registers (name, offset,
description, fields with bit range and access type), the IO MUX pad functions and the GPIO
matrix signal names, for the JTAG inspector to explain raw addresses and values.

Sources: ESP-IDF's register headers (soc/esp32s3/register/soc/*_reg.h, the machine-readable
form of the Technical Reference Manual's register tables) and, optionally, the text of the TRM
itself, whose "Register Summary" tables give a one-line description of each register where the
headers have none.

  toolchain/scripts/gen-soc-registers.py <idf soc/esp32s3 dir> [trm.txt]

trm.txt: the TRM PDF as text (e.g. `pypdf`'s extract_text, page by page).
"""
import json
import re
import sys
from pathlib import Path

SOC = Path(sys.argv[1])
TRM = Path(sys.argv[2]) if len(sys.argv) > 2 else None
OUT = Path(__file__).resolve().parents[2] / "src/debug/jtag/soc/esp32s3.json"

# Peripheral instances: (name shown, header, base macro as used in it, base address).
# Bases from TRM Table 4.3-3 (Module/Peripheral Address Mapping) / reg_base.h.
INSTANCES = [
    ("UART0", "uart_reg.h", "REG_UART_BASE(i)", 0x60000000),
    ("SPI1 (flash)", "spi_mem_reg.h", "REG_SPI_MEM_BASE(i)", 0x60002000),
    ("SPI0 (flash/PSRAM cache)", "spi_mem_reg.h", "REG_SPI_MEM_BASE(i)", 0x60003000),
    ("GPIO", "gpio_reg.h", "DR_REG_GPIO_BASE", 0x60004000),
    ("GPIO sigma-delta", "gpio_sd_reg.h", "DR_REG_GPIO_SD_BASE", 0x60004F00),
    ("eFuse", "efuse_reg.h", "DR_REG_EFUSE_BASE", 0x60007000),
    ("RTC control (low-power management)", "rtc_cntl_reg.h", "DR_REG_RTCCNTL_BASE", 0x60008000),
    ("RTC IO", "rtc_io_reg.h", "DR_REG_RTCIO_BASE", 0x60008400),
    ("RTC sensors", "sens_reg.h", "DR_REG_SENS_BASE", 0x60008800),
    ("RTC I2C", "rtc_i2c_reg.h", "DR_REG_RTC_I2C_BASE", 0x60008C00),
    ("IO MUX", "io_mux_reg.h", "REG_IO_MUX_BASE", 0x60009000),
    ("I2S0", "i2s_reg.h", "REG_I2S_BASE(i)", 0x6000F000),
    ("UART1", "uart_reg.h", "REG_UART_BASE(i)", 0x60010000),
    ("I2C0", "i2c_reg.h", "DR_REG_I2C_BASE", 0x60013000),
    ("UHCI0", "uhci_reg.h", "REG_UHCI_BASE(i)", 0x60014000),
    ("RMT (remote control)", "rmt_reg.h", "DR_REG_RMT_BASE", 0x60016000),
    ("PCNT (pulse counter)", "pcnt_reg.h", "DR_REG_PCNT_BASE", 0x60017000),
    ("LEDC (LED PWM)", "ledc_reg.h", "DR_REG_LEDC_BASE", 0x60019000),
    ("MCPWM0 (motor PWM)", "mcpwm_reg.h", "DR_REG_MCPWM_BASE(i)", 0x6001E000),
    ("Timer group 0", "timer_group_reg.h", "REG_TIMG_BASE(i)", 0x6001F000),
    ("Timer group 1", "timer_group_reg.h", "REG_TIMG_BASE(i)", 0x60020000),
    ("System timer", "systimer_reg.h", "DR_REG_SYSTIMER_BASE", 0x60023000),
    ("SPI2", "spi_reg.h", "REG_SPI_BASE(i)", 0x60024000),
    ("SPI3", "spi_reg.h", "REG_SPI_BASE(i)", 0x60025000),
    ("SYSCON (APB control)", "syscon_reg.h", "DR_REG_SYSCON_BASE", 0x60026000),
    ("I2C1", "i2c_reg.h", "DR_REG_I2C_BASE", 0x60027000),
    ("SD/MMC host", "sdmmc_reg.h", "DR_REG_SDMMC_BASE", 0x60028000),
    ("MCPWM1 (motor PWM)", "mcpwm_reg.h", "DR_REG_MCPWM_BASE(i)", 0x6002C000),
    ("I2S1", "i2s_reg.h", "REG_I2S_BASE(i)", 0x6002D000),
    ("UART2", "uart_reg.h", "REG_UART_BASE(i)", 0x6002E000),
    ("USB Serial/JTAG", "usb_serial_jtag_reg.h", "DR_REG_USB_SERIAL_JTAG_BASE", 0x60038000),
    ("USB wrapper", "usb_wrap_reg.h", "DR_REG_USB_WRAP_BASE", 0x60039000),
    ("GDMA (DMA controller)", "gdma_reg.h", "DR_REG_GDMA_BASE", 0x6003F000),
    ("ADC controller", "apb_saradc_reg.h", "DR_REG_APB_SARADC_BASE", 0x60040000),
    ("LCD/camera", "lcd_cam_reg.h", "DR_REG_LCD_CAM_BASE", 0x60041000),
    ("System registers", "system_reg.h", "DR_REG_SYSTEM_BASE", 0x600C0000),
    ("Permission control (PMS)", "sensitive_reg.h", "DR_REG_SENSITIVE_BASE", 0x600C1000),
    ("Interrupt matrix (core 0)", "interrupt_core0_reg.h", "DR_REG_INTERRUPT_CORE0_BASE", 0x600C2000),
    ("Interrupt matrix (core 1)", "interrupt_core1_reg.h", "DR_REG_INTERRUPT_CORE1_BASE", 0x600C2000),
    ("Cache and MMU (EXTMEM)", "extmem_reg.h", "DR_REG_EXTMEM_BASE", 0x600C4000),
    ("Debug assist", "assist_debug_reg.h", "DR_REG_ASSIST_DEBUG_BASE", 0x600CE000),
    ("World controller", "world_controller_reg.h", "DR_REG_WCL_BASE", 0x600D0000),
]

REG_DEF = re.compile(r"#define\s+([A-Z0-9_]+_REG)(?:\s*\(\s*i\s*\))?\s+\(\s*([A-Z0-9_]+(?:\s*\(\s*i\s*\))?)\s*\+\s*\(?\s*(0x[0-9a-fA-F]+|\d+)\s*\)?\s*\)")
NEW_FIELD = re.compile(r"/\*\*\s*([A-Z0-9_]+)\s*:\s*([A-Z0-9/]+)\s*;\s*bitpos:\s*\[(\d+)(?::(\d+))?\]")
OLD_FIELD = re.compile(r"/\*\s*([A-Z0-9_]+)\s*:\s*([A-Z0-9/]+)\s*;\s*bitpos:\s*\[(\d+)(?::(\d+))?\]")
REG_DOC = re.compile(r"/\*\*\s*([A-Z0-9_]+_REG)\s+register\s*$")


def short(text: str, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", text).strip().rstrip(".")
    if text in ("", "."):
        return ""
    first = re.split(r"(?<=[a-z0-9)])\.\s", text)[0]
    return first if len(first) <= limit else first[: limit - 1].rstrip() + "…"


def parse_header(path: Path, base_macro: str):
    """Registers of one header whose address is base_macro + offset, with their fields."""
    lines = path.read_text(errors="replace").splitlines()
    regs = {}  # name -> dict
    order = []
    current = None
    pending_doc = None  # (reg name, description) from a "/** X_REG register" block
    i = 0
    norm = lambda s: re.sub(r"\s+", "", s)
    while i < len(lines):
        line = lines[i]
        m = REG_DOC.search(line)
        if m:
            desc = []
            i += 1
            while i < len(lines) and "*/" not in lines[i]:
                desc.append(lines[i].strip().lstrip("*").strip())
                i += 1
            pending_doc = (m.group(1), short(" ".join(desc)))
            i += 1
            continue
        m = REG_DEF.search(line)
        if m and norm(m.group(2)) == norm(base_macro):
            name, off = m.group(1), int(m.group(3), 0)
            reg = {"name": name, "off": off, "desc": "", "fields": []}
            if pending_doc and pending_doc[0] == name:
                reg["desc"] = pending_doc[1]
            pending_doc = None
            if name not in regs:
                regs[name] = reg
                order.append(name)
            current = regs[name]
            i += 1
            continue
        m = NEW_FIELD.search(line) or OLD_FIELD.search(line)
        if m and current is not None:
            fname, access, hi = m.group(1), m.group(2), int(m.group(3))
            lo = int(m.group(4)) if m.group(4) is not None else hi
            desc = []
            if "*/" in line and line.strip().startswith("/*") and not line.strip().startswith("/**"):
                # old style: /* NAME : RO ;bitpos:[..] ;default: .. ; */ then /*description: ...*/
                j = i + 1
                text = ""
                while j < len(lines) and not lines[j].strip().startswith("#define"):
                    text += " " + lines[j].strip()
                    if "*/" in lines[j]:
                        break
                    j += 1
                text = re.sub(r"^\s*/\*\s*description:\s*", "", text).replace("*/", "")
                desc = [text]
                i = j
            else:
                j = i + 1
                while j < len(lines) and "*/" not in lines[j]:
                    desc.append(lines[j].strip().lstrip("*").strip())
                    j += 1
                i = j
            current["fields"].append([fname, lo, hi, access, short(" ".join(desc), 140)])
        i += 1
    return [regs[n] for n in order]


def trm_summaries():
    """Register name -> one-line description, from the TRM's Register Summary tables."""
    if not TRM or not TRM.exists():
        return {}
    out = {}
    row = re.compile(r"^([A-Z][A-Z0-9_]+_REG)\s+(.+?)\s*(0x[0-9A-Fa-f]{4})\s+(\S+)\s*$")
    for line in TRM.read_text(errors="replace").splitlines():
        m = row.match(line.strip())
        if m and m.group(1) not in out:
            out[m.group(1)] = short(m.group(2).replace(" ~", "–"))
    return out


def iomux():
    """Per GPIO: the IO MUX register offset and its function names by MCU_SEL value."""
    text = (SOC / "register/soc/io_mux_reg.h").read_text()
    pad_off = {m.group(1): int(m.group(2), 16) for m in re.finditer(r"#define PERIPHS_IO_MUX_([A-Z0-9_]+)_U\s+\(REG_IO_MUX_BASE\s*\+\s*(0x[0-9a-fA-F]+)\)", text)}
    pins = {}
    for m in re.finditer(r"#define IO_MUX_GPIO(\d+)_REG\s+PERIPHS_IO_MUX_([A-Z0-9_]+)_U", text):
        gpio, pad = int(m.group(1)), m.group(2)
        funcs = {}
        # Pad names can prefix each other (SPICLK, SPICLK_N): skip another pad's functions.
        longer = [p for p in pad_off if p != pad and p.startswith(pad + "_")]
        for f in re.finditer(rf"#define FUNC_{pad}_([A-Z0-9_]+)\s+(\d+)", text):
            name, value = f.group(1), int(f.group(2))
            if any(f"{pad}_{name}".startswith(p + "_") for p in longer):
                continue
            if value not in funcs or not name.endswith("_0"):
                funcs[value] = name
        pins[gpio] = {"off": pad_off[pad], "pad": pad, "funcs": {str(k): re.sub(r"_0$", "", v) for k, v in sorted(funcs.items())}}
    return pins


def signals():
    text = (SOC / "include/soc/gpio_sig_map.h").read_text()
    out, inp, unmarked = {}, {}, []
    for m in re.finditer(r"#define ([A-Z0-9_]+)_IDX\s+(\d+)", text):
        name, idx = m.group(1), m.group(2)
        # U0TXD_OUT, RMT_SIG_OUT0, LEDC_LS_SIG_OUT0: outputs; U0RXD_IN, RMT_SIG_IN0: inputs.
        is_out = re.search(r"(^|_)(OUT|TX|TXD)\d*(_|$)|_OUT$", name)
        is_in = re.search(r"(^|_)(IN|RX|RXD)\d*(_|$)|_IN$", name)
        clean = re.sub(r"_(OUT|IN)$", "", name)
        if is_out:
            out.setdefault(idx, clean)
        if is_in:
            inp.setdefault(idx, clean)
        if not is_in and not is_out:
            unmarked.append((idx, clean))
    # Names that don't say in or out (EXT_ADC_START) only fill indexes nothing else named.
    for idx, clean in unmarked:
        out.setdefault(idx, clean)
        inp.setdefault(idx, clean)
    return {"in": inp, "out": out}


# The IO MUX pad register layout (io_mux_reg.h); the same for every pad.
IOMUX_FIELDS = [
    ["SLP_OE", 0, 0, "R/W", "Output enable while the chip sleeps (with SLP_SEL)"],
    ["SLP_SEL", 1, 1, "R/W", "Use the sleep-mode settings (bits 0-6) instead of the normal ones"],
    ["SLP_PD", 2, 2, "R/W", "Pull-down while sleeping"],
    ["SLP_PU", 3, 3, "R/W", "Pull-up while sleeping"],
    ["SLP_IE", 4, 4, "R/W", "Input enable while sleeping"],
    ["SLP_DRV", 5, 6, "R/W", "Drive strength while sleeping"],
    ["FUN_PD", 7, 7, "R/W", "Internal pull-down resistor on"],
    ["FUN_PU", 8, 8, "R/W", "Internal pull-up resistor on"],
    ["FUN_IE", 9, 9, "R/W", "Input enable: the pin's level can be read"],
    ["FUN_DRV", 10, 11, "R/W", "Drive strength: 0 ~5 mA, 1 ~10 mA, 2 ~20 mA, 3 ~40 mA"],
    ["MCU_SEL", 12, 14, "R/W", "Function select: which signal the pad connects to (see the pin's function list)"],
    ["FILTER_EN", 15, 15, "R/W", "Glitch filter on the input"],
]


def main():
    summaries = trm_summaries()
    peripherals = []
    pins = iomux()
    for title, header, macro, base in INSTANCES:
        regs = parse_header(SOC / "register/soc" / header, macro)
        if header == "io_mux_reg.h":
            for gpio, pin in sorted(pins.items()):
                regs.append({"name": f"IO_MUX_GPIO{gpio}_REG", "off": pin["off"], "desc": f"Pad configuration of GPIO{gpio} (pad {pin['pad']})", "fields": IOMUX_FIELDS})
        for r in regs:
            r["fields"].sort(key=lambda f: f[1])
        for r in regs:
            if not r["desc"]:
                r["desc"] = summaries.get(r["name"], "")
        size = max((r["off"] for r in regs), default=0) + 4
        peripherals.append({
            "title": title, "base": base, "size": size,
            "regs": [[r["off"], r["name"], r["desc"], r["fields"]] for r in sorted(regs, key=lambda r: r["off"])],
        })
        print(f"{title:40s} {len(regs):4d} registers", file=sys.stderr)
    data = {"source": "ESP-IDF soc/esp32s3 register headers + ESP32-S3 TRM v1.8 register summaries",
            "peripherals": peripherals, "iomux": pins, "signals": signals()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)", file=sys.stderr)


main()
