"""Poll in-transit orders and mark confirmed deliveries as arrived."""

import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DB = "/data/app.sqlite3"
SCRAPER_URL = os.getenv("TRACKING_SCRAPER_URL", "http://tracking-scraper:8080").rstrip("/")
POLL_SECONDS = max(60, int(os.getenv("TRACKING_POLL_SECONDS", "900")))
REQUEST_TIMEOUT = 45
_carrier_ids = None

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def carrier_id(label):
    """Translate the configured carrier label to a scraper catalog id when possible."""
    global _carrier_ids
    if _carrier_ids is None:
        request = Request(f"{SCRAPER_URL}/v1/carriers")
        try:
            with urlopen(request, timeout=10) as response:
                catalog = json.loads(response.read(10_000_000))
            _carrier_ids = {}
            for identifier, details in catalog.items():
                for name in [identifier, details.get("displayName", ""), *details.get("aliases", [])]:
                    normalized = " ".join(name.casefold().split())
                    if normalized:
                        _carrier_ids.setdefault(normalized, set()).add(identifier)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, AttributeError):
            _carrier_ids = {}

    normalized = " ".join((label or "").casefold().split())
    matches = _carrier_ids.get(normalized, set())
    return next(iter(matches)) if len(matches) == 1 else None


def get_tracking_result(number, carrier):
    payload_data = {"number": number, "language": "de", "budgetMs": 30000}
    identifier = carrier_id(carrier)
    if identifier:
        payload_data["carrier"] = identifier
    payload = json.dumps(payload_data).encode()
    request = Request(
        f"{SCRAPER_URL}/v1/track",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
        return json.loads(response.read(2_000_000))


def reported_stage(result):
    details = result.get("result") or {}
    stage = details.get("current_stage")
    if isinstance(stage, str) and stage.strip():
        return stage.strip()
    status = details.get("status")
    return status.strip() if isinstance(status, str) else "unknown"


def parse_instant(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def delivery_timestamp(result):
    details = result.get("result") or {}
    events = details.get("events")
    if not isinstance(events, list):
        events = []
    delivered_events = [
        event for event in events
        if isinstance(event, dict) and str(event.get("stage", "")).casefold() == "delivered"
    ]
    instants = [parse_instant(event.get("instant")) for event in delivered_events]
    instants = [instant for instant in instants if instant]
    if instants:
        return max(instants)
    return parse_instant(details.get("last_update"))


def mark_arrived(order, delivered_at=None):
    connection = sqlite3.connect(DB, timeout=15)
    try:
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT status, tracking_number FROM orders WHERE id=?", (order["id"],)
        ).fetchone()
        if not current or current[0] != "Unterwegs" or current[1] != order["tracking_number"]:
            connection.rollback()
            return False
        timestamp = now()
        arrival_time = delivered_at or timestamp
        connection.execute(
            "UPDATE orders SET status='Angekommen', updated_at=? WHERE id=?",
            (timestamp, order["id"]),
        )
        connection.execute(
            "INSERT INTO events(order_id, action, actor_name, created_at) VALUES(?,?,?,?)",
            (
                order["id"],
                "Status: Unterwegs → Angekommen",
                "Automatische Sendungsverfolgung",
                arrival_time,
            ),
        )
        connection.commit()
        return True
    finally:
        connection.close()


def repair_arrival_dates():
    """Replace detection timestamps on automated arrivals with carrier scan times."""
    connection = sqlite3.connect(DB, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        orders = connection.execute(
            "SELECT DISTINCT o.id, o.tracking_number, o.carrier FROM orders o "
            "JOIN events e ON e.order_id=o.id "
            "WHERE o.status='Angekommen' AND e.actor_name='Automatische Sendungsverfolgung' "
            "AND e.action='Status: Unterwegs → Angekommen' "
            "AND TRIM(COALESCE(o.tracking_number,''))<>'' ORDER BY o.id"
        ).fetchall()
    finally:
        connection.close()

    for order in orders:
        try:
            result = get_tracking_result(order["tracking_number"], order["carrier"])
            delivered_at = delivery_timestamp(result) if reported_stage(result).casefold() == "delivered" else None
            if not delivered_at:
                continue
            connection = sqlite3.connect(DB, timeout=15)
            try:
                connection.execute("PRAGMA busy_timeout=5000")
                connection.execute(
                    "UPDATE events SET created_at=? WHERE id=(SELECT MAX(id) FROM events "
                    "WHERE order_id=? AND actor_name='Automatische Sendungsverfolgung' "
                    "AND action='Status: Unterwegs → Angekommen') AND EXISTS "
                    "(SELECT 1 FROM orders WHERE id=? AND status='Angekommen')",
                    (delivered_at, order["id"], order["id"]),
                )
                connection.commit()
                logging.info("Updated delivery time for order %s to %s", order["id"], delivered_at)
            finally:
                connection.close()
        except HTTPError as error:
            logging.warning("Could not refresh delivery time for order %s (HTTP %s)", order["id"], error.code)
        except (URLError, TimeoutError, OSError, ValueError, TypeError) as error:
            logging.warning("Could not refresh delivery time for order %s: %s", order["id"], type(error).__name__)


def poll_once():
    connection = sqlite3.connect(DB, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        orders = connection.execute(
            "SELECT id, tracking_number, carrier FROM orders "
            "WHERE status='Unterwegs' AND TRIM(COALESCE(tracking_number,''))<>'' ORDER BY id"
        ).fetchall()
    finally:
        connection.close()

    for order in orders:
        try:
            result = get_tracking_result(order["tracking_number"], order["carrier"])
            stage = reported_stage(result)
            logging.info(
                "Tracking result for order %s: stage=%s carrier=%s source=%s",
                order["id"], stage, result.get("carrier", "unknown"), result.get("source", "unknown"),
            )
            if stage.casefold() == "delivered":
                delivered_at = delivery_timestamp(result)
                if mark_arrived(order, delivered_at):
                    logging.info(
                        "Order %s was confirmed delivered%s",
                        order["id"], f" at {delivered_at}" if delivered_at else " (delivery time unavailable)",
                    )
        except HTTPError as error:
            try:
                details = json.loads(error.read(16_384))
                reason = details.get("error") or (details.get("hint") or {}).get("kind") or ""
            except (ValueError, AttributeError):
                reason = ""
            logging.warning(
                "Tracking lookup for order %s returned HTTP %s%s",
                order["id"], error.code, f" ({reason[:120]})" if reason else "",
            )
        except (URLError, TimeoutError, OSError, ValueError, TypeError) as error:
            logging.warning("Tracking lookup for order %s failed: %s", order["id"], type(error).__name__)


def main():
    logging.info("Tracking worker started; polling every %s seconds", POLL_SECONDS)
    try:
        repair_arrival_dates()
    except sqlite3.Error as error:
        logging.warning("Could not refresh previous delivery times: %s", type(error).__name__)
    while True:
        try:
            poll_once()
        except sqlite3.Error as error:
            logging.warning("Tracking database is not ready: %s", type(error).__name__)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
