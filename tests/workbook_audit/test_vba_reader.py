"""VBA extraction: MS-OVBA decompression correctness and VALIDATION:
document macro behavior rather than assume it is benign."""
import struct

import pytest

from tools.workbook_audit.vba_reader import decompress_stream, VbaFormatError, extract_vba


def _build_raw_chunk_container(payload: bytes) -> bytes:
    """Construct a minimal valid CompressedContainer using an uncompressed
    ('raw') chunk, per MS-OVBA 2.4.1.1.4 — the one encoding we can build
    by hand without reimplementing the LZ77-style compressor."""
    assert len(payload) <= 4096
    padded = payload + b"\x00" * (4096 - len(payload))
    chunk_size = 4098 - 3  # header(2) + 4096 data - 3, per spec's size-3 encoding
    header = (0 << 15) | (0b011 << 12) | chunk_size
    return b"\x01" + struct.pack("<H", header) + padded


def test_decompress_stream_rejects_bad_signature():
    with pytest.raises(VbaFormatError):
        decompress_stream(b"\x00\x00\x00")


def test_decompress_stream_raw_chunk_roundtrip():
    payload = b"Attribute VB_Name = \"Test\"\r\n"
    container = _build_raw_chunk_container(payload)
    result = decompress_stream(container)
    assert result.startswith(payload)


def test_extract_vba_finds_all_modules(raw_zip):
    modules = extract_vba(raw_zip.read)
    assert len(modules) == 96  # 95 sheet modules + ThisWorkbook


def test_extract_vba_module_names_are_well_formed(raw_zip):
    modules = extract_vba(raw_zip.read)
    names = {m.name for m in modules}
    assert "ThisWorkbook" in names
    assert all(n == "ThisWorkbook" or n.startswith("Sheet") for n in names)


def test_only_two_modules_contain_executable_code(raw_zip):
    """VALIDATION / risk-register.md R13: document macro behavior exactly
    rather than guess. Every module gets 9 lines of Attribute boilerplate;
    anything beyond that is real code."""
    modules = extract_vba(raw_zip.read)
    with_code = [m for m in modules if m.line_count > 9]
    assert {m.name for m in with_code} == {"Sheet3", "Sheet4"}


def test_no_autoopen_or_workbook_open_macro_exists(raw_zip):
    """Confirms risk-register.md R13's claim that no macro fires
    automatically on file open — relevant since ForgeOS's importer must
    not assume any macro side-effects need to be replicated."""
    modules = extract_vba(raw_zip.read)
    assert not any(m.has_auto_open for m in modules)
    assert not any(m.has_workbook_open for m in modules)


def test_sheet3_calendar_popup_code_is_the_only_real_logic(raw_zip):
    modules = {m.name: m for m in extract_vba(raw_zip.read)}
    assert "Worksheet_SelectionChange" in modules["Sheet3"].source
    assert "Calendar" in modules["Sheet3"].source
