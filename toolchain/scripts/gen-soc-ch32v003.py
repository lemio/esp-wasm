#!/usr/bin/env python3
"""
Generate src/debug/jtag/soc/ch32v003.json: the CH32V003's peripheral registers (name, offset,
description, fields with bit range and access type), for the inspector to explain raw
addresses and values, in the same form as esp32s3.json (gen-soc-registers.py).

Source: WCH's SVD file, as ch32fun ships it (misc/CH32V003xx.svd). The SysTick timer (STK),
which the SVD leaves out, is added from the QingKe V2 processor manual.

  toolchain/scripts/gen-soc-ch32v003.py [toolchain/out/ch32fun/misc/CH32V003xx.svd]
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SVD = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "toolchain/out/ch32fun/misc/CH32V003xx.svd"
OUT = ROOT / "src/debug/jtag/soc/ch32v003.json"

ACCESS = {"read-write": "R/W", "read-only": "RO", "write-only": "WO", "writeOnce": "WO", "read-writeOnce": "R/W"}

# Names shown for the peripherals (the SVD's descriptions, shortened).
TITLES = {
    "PWR": "PWR (power control)", "RCC": "RCC (reset and clock control)", "EXTEN": "EXTEN (extended configuration)",
    "GPIOA": "GPIOA", "GPIOC": "GPIOC", "GPIOD": "GPIOD", "AFIO": "AFIO (alternate functions and remapping)",
    "EXTI": "EXTI (external interrupts)", "DMA1": "DMA1", "IWDG": "IWDG (independent watchdog)",
    "WWDG": "WWDG (window watchdog)", "TIM1": "TIM1 (advanced timer)", "TIM2": "TIM2 (general-purpose timer)",
    "I2C1": "I2C1", "SPI1": "SPI1", "USART1": "USART1", "ADC1": "ADC1", "DBG": "DBG (debug support)",
    "ESIG": "ESIG (electronic signature)", "FLASH": "FLASH (flash controller)",
    "PFIC": "PFIC (interrupt controller)", "STK": "SysTick (system timer)",
}

STK = {
    "title": TITLES["STK"], "base": 0xE000F000, "size": 0x14,
    "regs": [
        [0x0, "STK_CTLR", "SysTick control register", [
            ["STE", 0, 0, "R/W", "Counter enable"],
            ["STIE", 1, 1, "R/W", "Counter interrupt enable"],
            ["STCLK", 2, 2, "R/W", "Clock source: 1 = HCLK, 0 = HCLK/8"],
            ["STRE", 3, 3, "R/W", "Auto-reload: count from 0 again after reaching CMP"],
            ["SWIE", 31, 31, "R/W", "Software interrupt trigger"],
        ]],
        [0x4, "STK_SR", "SysTick status register", [["CNTIF", 0, 0, "R/W", "Count reached CMP (write 0 to clear)"]]],
        [0x8, "STK_CNT", "SysTick counter (the current count)", [["CNT", 0, 31, "R/W", "Counter value"]]],
        [0x10, "STK_CMP", "SysTick compare value", [["CMP", 0, 31, "R/W", "Compare value"]]],
    ],
}


def text(e, tag, default=""):
    v = e.findtext(tag)
    return re.sub(r"\s+", " ", v).strip() if v else default


def num(s):
    return int(s, 0)


def main():
    root = ET.parse(SVD).getroot()
    raw = {p.findtext("name"): p for p in root.find("peripherals")}
    peripherals = []
    for name, p in raw.items():
        src = raw[p.get("derivedFrom")] if p.get("derivedFrom") else p
        base = num(p.findtext("baseAddress"))
        regs = []
        for r in (src.find("registers") if src.find("registers") is not None else []):
            off = num(r.findtext("addressOffset"))
            racc = r.findtext("access") or "read-write"
            fields = []
            for f in (r.find("fields") if r.find("fields") is not None else []):
                lo = num(f.findtext("bitOffset"))
                width = num(f.findtext("bitWidth"))
                acc = ACCESS.get(f.findtext("access") or racc, "R/W")
                fields.append([text(f, "name"), lo, lo + width - 1, acc, text(f, "description")])
            fields.sort(key=lambda x: x[1])
            regs.append([off, f"{name}_{text(r, 'name')}", text(r, "description"), fields])
        regs.sort(key=lambda x: x[0])
        size = max([r[0] + 4 for r in regs] or [4])
        peripherals.append({"title": TITLES.get(name, name), "base": base, "size": size, "regs": regs})
    peripherals.append(STK)
    peripherals.sort(key=lambda p: p["base"])
    OUT.write_text(json.dumps({
        "source": f"WCH {SVD.name} (from ch32fun) + SysTick from the QingKe V2 manual",
        "peripherals": peripherals, "iomux": {}, "signals": {"in": {}, "out": {}},
    }, separators=(",", ":")))
    print(f"{OUT}: {len(peripherals)} peripherals, {sum(len(p['regs']) for p in peripherals)} registers")


main()
