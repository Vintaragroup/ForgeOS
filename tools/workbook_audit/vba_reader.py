"""VBA project extraction from xl/vbaProject.bin.

vbaProject.bin is an OLE Compound File (CFBF), which openpyxl does not
parse. We use `olefile` (the sole non-stdlib dependency this audit adds —
see docs/audit-plan.md) to read the CFBF container, then implement the
MS-OVBA "Compressed Container" decompression algorithm ourselves (it is a
compact, fully documented RLE/LZ variant — MS-OVBA 2.4.1) rather than
pulling in oletools/pcodedmp and their extra transitive dependencies.

The `dir` stream is itself a compressed container whose decompressed form
is a binary record stream (MS-OVBA 2.3.4.2) that lists every module, its
backing OLE stream name, and the byte offset within that stream where the
*source text* (as opposed to compiled p-code) begins. We only need the
module inventory + text offsets, so rather than fully modeling the
irregular PROJECTREFERENCES record layouts (REFERENCECONTROL etc., which
have non-uniform nested Id/Size structures), we anchor on the fixed-size,
unambiguous PROJECTMODULES record header (Id=0x000F, Size=0x00000002) and
parse generically from there — every record in the modules section uses a
regular Id(2)+Size(4)+Data(Size) layout.
"""
from __future__ import annotations

import io
import struct
from dataclasses import dataclass, field
from pathlib import Path

import olefile

PROJECTMODULES_MAGIC = b"\x0f\x00\x02\x00\x00\x00"


class VbaFormatError(RuntimeError):
    pass


def decompress_stream(data: bytes) -> bytes:
    """MS-OVBA 2.4.1 CompressedContainer -> DecompressedBuffer."""
    if not data or data[0] != 0x01:
        raise VbaFormatError(f"bad compressed container signature: {data[:1]!r}")
    out = bytearray()
    pos = 1
    size = len(data)
    while pos < size:
        if pos + 2 > size:
            break
        header = struct.unpack_from("<H", data, pos)[0]
        chunk_size = (header & 0x0FFF) + 3
        chunk_flag = (header >> 15) & 0x1
        chunk_start = pos
        pos += 2
        chunk_end = min(chunk_start + chunk_size, size)
        if chunk_flag == 0:
            # Raw chunk: always 4096 bytes of literal data (spec 2.4.1.1.4)
            raw = data[pos:pos + 4096]
            out += raw
            pos += 4096
        else:
            chunk_decomp_start = len(out)
            while pos < chunk_end:
                flag_byte = data[pos]
                pos += 1
                for bit in range(8):
                    if pos >= chunk_end:
                        break
                    if not (flag_byte >> bit) & 1:
                        out.append(data[pos])
                        pos += 1
                    else:
                        if pos + 2 > chunk_end:
                            pos = chunk_end
                            break
                        token = struct.unpack_from("<H", data, pos)[0]
                        pos += 2
                        decomp_current = len(out) - chunk_decomp_start
                        bit_count = max((decomp_current - 1).bit_length() if decomp_current > 0 else 0, 4)
                        length_mask = 0xFFFF >> bit_count
                        offset_mask = (~length_mask) & 0xFFFF
                        length = (token & length_mask) + 3
                        temp = (token & offset_mask) >> (16 - bit_count)
                        offset = temp + 1
                        copy_source = len(out) - offset
                        for i in range(length):
                            out.append(out[copy_source + i])
    return bytes(out)


@dataclass
class VbaModule:
    name: str
    stream_name: str
    module_type: str  # procedural | document
    text_offset: int
    source: str = ""
    line_count: int = 0
    has_auto_open: bool = False
    has_workbook_open: bool = False
    referenced_names: list = field(default_factory=list)


def _read_record(buf: bytes, pos: int):
    id_ = struct.unpack_from("<H", buf, pos)[0]
    pos += 2
    if id_ == 0x0009:  # PROJECTVERSION: irregular fixed layout
        pos += 4  # Reserved (always 0x00000004)
        data = buf[pos:pos + 6]
        pos += 6
        return id_, data, pos
    size = struct.unpack_from("<I", buf, pos)[0]
    pos += 4
    data = buf[pos:pos + size]
    pos += size
    return id_, data, pos


def parse_dir_stream(dir_decompressed: bytes) -> list[dict]:
    anchor = dir_decompressed.find(PROJECTMODULES_MAGIC)
    if anchor == -1:
        raise VbaFormatError("PROJECTMODULES record not found in dir stream")
    pos = anchor + len(PROJECTMODULES_MAGIC)
    count = struct.unpack_from("<H", dir_decompressed, pos)[0]
    pos += 2

    modules = []
    current: dict = {}
    while len(modules) < count and pos < len(dir_decompressed):
        id_, data, pos = _read_record(dir_decompressed, pos)
        if id_ == 0x0013:  # PROJECTCOOKIE
            continue
        elif id_ == 0x0019:  # MODULENAME
            current["name"] = data.decode("cp1252", errors="replace")
        elif id_ == 0x0047:  # MODULENAMEUNICODE
            pass
        elif id_ == 0x001A:  # MODULESTREAMNAME
            current["stream_name"] = data.decode("cp1252", errors="replace")
        elif id_ == 0x0032:  # MODULESTREAMNAMEUNICODE
            pass
        elif id_ == 0x001C:  # MODULEDOCSTRING
            pass
        elif id_ == 0x0048:  # MODULEDOCSTRINGUNICODE
            pass
        elif id_ == 0x0031:  # MODULEOFFSET
            current["text_offset"] = struct.unpack("<I", data)[0]
        elif id_ == 0x001E:  # MODULEHELPCONTEXT
            pass
        elif id_ == 0x002C:  # MODULECOOKIE
            pass
        elif id_ == 0x0021:  # MODULETYPE = procedural
            current["module_type"] = "procedural"
        elif id_ == 0x0022:  # MODULETYPE = document/class
            current["module_type"] = "document"
        elif id_ == 0x0025:  # MODULEREADONLY
            current["readonly"] = True
        elif id_ == 0x0028:  # MODULEPRIVATE
            current["private"] = True
        elif id_ == 0x002B:  # MODULETERMINATOR
            modules.append(current)
            current = {}
        # unknown ids: ignored, already consumed via generic size skip
    return modules


AUTO_TRIGGERS = ("Workbook_Open", "Auto_Open", "Workbook_BeforeSave", "Workbook_BeforeClose", "Worksheet_Change", "Worksheet_Activate", "Workbook_SheetActivate")


def extract_vba(xlsm_bytes_by_member) -> list[VbaModule]:
    """xlsm_bytes_by_member: callable(member_path) -> bytes, from the zip."""
    raw = xlsm_bytes_by_member("xl/vbaProject.bin")
    ole = olefile.OleFileIO(io.BytesIO(raw))

    dir_compressed = ole.openstream("VBA/dir").read()
    dir_decompressed = decompress_stream(dir_compressed)
    module_records = parse_dir_stream(dir_decompressed)

    modules = []
    for rec in module_records:
        stream_name = rec.get("stream_name")
        text_offset = rec.get("text_offset", 0)
        module_type = rec.get("module_type", "unknown")
        name = rec.get("name", stream_name or "?")
        source = ""
        if stream_name:
            stream_path = f"VBA/{stream_name}"
            if ole.exists(stream_path):
                module_bytes = ole.openstream(stream_path).read()
                compressed_source = module_bytes[text_offset:]
                try:
                    source_bytes = decompress_stream(compressed_source)
                    source = source_bytes.decode("cp1252", errors="replace")
                except VbaFormatError:
                    source = ""
        mod = VbaModule(
            name=name,
            stream_name=stream_name or "",
            module_type=module_type,
            text_offset=text_offset,
            source=source,
            line_count=source.count("\n") + 1 if source.strip() else 0,
            has_auto_open=any(t in source for t in ("Sub Auto_Open", "Sub Workbook_Open")),
            has_workbook_open="Workbook_Open" in source,
            referenced_names=sorted({t for t in AUTO_TRIGGERS if t in source}),
        )
        modules.append(mod)
    ole.close()
    return modules
