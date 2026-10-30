"""Import helpers for Mouser's saved-cart Excel exports."""

import math
import re

import xlrd


class ImportFormatError(ValueError):
    """Raised when a workbook cannot be mapped to order line items."""


def _text(value):
    if value is None:
        return ""
    return str(value).strip()


def _key(value):
    return "".join(char for char in _text(value).casefold() if char.isalnum())


def _column(headers, aliases, *, partial=False):
    keys = [_key(header) for header in headers]
    wanted = [_key(alias) for alias in aliases]
    for alias in wanted:
        for index, key in enumerate(keys):
            if key == alias:
                return index
    if partial:
        for alias in wanted:
            for index, key in enumerate(keys):
                if alias and key.startswith(alias):
                    return index
    return None


def _number(value, field):
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        raw = _text(value).replace("\xa0", "").replace(" ", "")
        raw = re.sub(r"[^0-9,.-]", "", raw)
        if "," in raw and "." in raw:
            if raw.rfind(",") > raw.rfind("."):
                raw = raw.replace(".", "").replace(",", ".")
            else:
                raw = raw.replace(",", "")
        elif "," in raw:
            raw = raw.replace(",", ".")
        try:
            number = float(raw)
        except ValueError as exc:
            raise ImportFormatError(f"Ungültiger Wert für {field}: {_text(value)}") from exc
    if not math.isfinite(number):
        raise ImportFormatError(f"Ungültiger Wert für {field}")
    return number


def parse_mouser_xls(file_bytes):
    """Return [(name, quantity, unit_price, link)] from a Mouser .xls export."""
    try:
        workbook = xlrd.open_workbook(file_contents=file_bytes, on_demand=True)
    except (xlrd.XLRDError, OSError, ValueError) as exc:
        raise ImportFormatError("Die Datei lässt sich nicht als Excel-XLS öffnen.") from exc

    if not workbook.sheet_names():
        raise ImportFormatError("Die Excel-Datei enthält kein Tabellenblatt.")
    sheet = workbook.sheet_by_index(0)
    header_row = None
    columns = None
    for row_index in range(min(sheet.nrows, 40)):
        headers = [sheet.cell_value(row_index, col) for col in range(sheet.ncols)]
        quantity_col = _column(headers, ("Quantity", "Qty", "Menge", "Bestellmenge", "Stückzahl", "Anzahl", "Q"), partial=True)
        part_col = _column(headers, ("Mouser Part Number", "Mouser Part #", "Mouser #", "Mouser No.", "Mouser Nr.", "Mouser Number", "Manufacturer Part Number", "Manufacturer Part #", "Mfr Part Number", "Mfr Part #", "Herst.-Nr.", "Herst. Nr.", "MPN", "Part Number", "Part #", "Artikelnummer"), partial=True)
        description_col = _column(headers, ("Description", "Product Description", "Beschreibung", "Artikelbeschreibung", "Bezeichnung", "Product", "Item Name"), partial=True)
        price_col = _column(headers, ("Unit Price", "Price Each", "Unit Cost", "Einzelpreis", "Preis pro Stück", "Price", "Preis"), partial=True)
        if (quantity_col is not None or price_col is not None) and (part_col is not None or description_col is not None):
            header_row = row_index
            link_col = _column(headers, ("Product Link", "Mouser Link", "URL", "Link"), partial=True)
            columns = (part_col, description_col, quantity_col, price_col, link_col)
            break
    if header_row is None:
        raise ImportFormatError("Keine passenden Spalten gefunden. Erwartet werden Artikel/Bestellnummer und Menge.")

    part_col, description_col, quantity_col, price_col, link_col = columns
    if quantity_col is None:
        # Some Mouser exports have an abbreviated/unlabelled quantity column.
        # Infer it from integer-valued cells next to the item description, before
        # the unit-price column, while excluding known text and price columns.
        item_col = description_col if description_col is not None else part_col
        data_rows = [r for r in range(header_row + 1, min(sheet.nrows, header_row + 31)) if _text(sheet.cell_value(r, item_col))]
        candidates = []
        for col in range(sheet.ncols):
            if col in (part_col, description_col, price_col, link_col):
                continue
            values = [sheet.cell_value(r, col) for r in data_rows]
            parsed = []
            for value in values:
                if value in ("", None):
                    continue
                try:
                    parsed.append(_number(value, "Menge"))
                except ImportFormatError:
                    parsed = []
                    break
            if parsed and all(0 < value <= 1_000_000 and value.is_integer() for value in parsed):
                before_price = col < price_col if price_col is not None else True
                candidates.append((before_price, col, len(parsed)))
        if candidates:
            candidates.sort(key=lambda candidate: (candidate[0], candidate[1]), reverse=True)
            quantity_col = candidates[0][1]
        else:
            raise ImportFormatError("Die Mengenspalte in der Mouser-Datei wurde nicht erkannt.")
    items = []
    for row_index in range(header_row + 1, sheet.nrows):
        row = [sheet.cell_value(row_index, col) for col in range(sheet.ncols)]
        part = _text(row[part_col]) if part_col is not None else ""
        description = _text(row[description_col]) if description_col is not None else ""
        if not part and not description:
            continue
        raw_quantity = row[quantity_col]
        if raw_quantity == "":
            continue
        quantity = _number(raw_quantity, "Menge")
        if quantity <= 0 or quantity > 1_000_000 or not quantity.is_integer():
            raise ImportFormatError(f"Die Menge in Excel-Zeile {row_index + 1} muss eine ganze Stückzahl sein.")
        raw_price = row[price_col] if price_col is not None else 0
        price = _number(raw_price or 0, "Einzelpreis")
        if price < 0 or price > 100_000_000:
            raise ImportFormatError(f"Ungültiger Einzelpreis in Excel-Zeile {row_index + 1}.")
        name = f"{part} — {description}" if part and description and part.casefold() not in description.casefold() else (part or description)
        link = _text(row[link_col]) if link_col is not None else ""
        if link and not link.startswith(("https://", "http://")):
            link = ""
        items.append((name[:200], quantity, price, link[:2000]))

    workbook.release_resources()
    if not items:
        raise ImportFormatError("In der Excel-Datei wurden keine Artikelpositionen gefunden.")
    return items
