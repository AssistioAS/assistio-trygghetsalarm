import argparse
import json
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

from skyresponse_import_safety_alarms import (
    DEFAULT_DATA_DIR,
    DEFAULT_SETTINGS_PATH,
    download_report_file,
    generate_report_filename,
    hydrate_api_settings_from_workspace,
    load_workspace_settings,
    login_and_get_token,
    read_xlsx_rows,
    resolve_workspace_from_settings,
)


REPORT_ID = 119
DEFAULT_OUTPUT_DIR = "Trygghetsalarmer_API/downloads"

IDENTIFIER_ALIASES = [
    "identifier",
    "identifikator",
    "abonnement",
    "brukerid",
    "senderid",
]
APARTMENT_ALIASES = ["leilighetnummer", "leilighet", "hybel", "romnummer", "romnr"]
HEARTBEAT_ALIASES = ["sistehjerteslag", "hjerteslag", "sistkommunikasjon", "sistekommunikasjon"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Skyresponse report 119 and merge heartbeat cache."
    )
    parser.add_argument("--xlsx", help="Use existing xlsx instead of downloading.")
    parser.add_argument("--download", action="store_true", help="Download the report before import.")
    parser.add_argument("--workspace-id", default="", help="Workspace id from settings.json.")
    parser.add_argument("--workspace-name", default="", help="Workspace name from settings.json.")
    parser.add_argument(
        "--settings-file",
        default=str(DEFAULT_SETTINGS_PATH),
        help="Path to settings.json.",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for downloaded reports.",
    )
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_header(value: Any) -> str:
    text = normalize_text(value).lower()
    text = text.replace("æ", "ae").replace("ø", "o").replace("å", "a")
    return "".join(ch for ch in text if ch.isalnum())


def normalize_alarm_identifier(value: Any) -> str:
    raw = normalize_text(value).replace(" ", "")
    if not raw:
      return ""
    if raw.startswith("+"):
        digits = "".join(ch for ch in raw[1:] if ch.isdigit())
        return f"+{digits}" if digits else ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return ""
    return f"+{digits}" if digits.startswith("46") else digits


def derive_heartbeat_file_path(api_settings: dict[str, Any]) -> Path:
    data_file_path = normalize_text(api_settings.get("dataFilePath"))
    if data_file_path:
        return Path(data_file_path).resolve().with_name("safety_alarm_heartbeats.json")
    return DEFAULT_DATA_DIR / "safety_alarm_heartbeats.json"


def derive_safety_alarms_file_path(api_settings: dict[str, Any]) -> Path:
    data_file_path = normalize_text(api_settings.get("dataFilePath"))
    if data_file_path:
        return Path(data_file_path).resolve().with_name("safety_alarms.json")
    return DEFAULT_DATA_DIR / "safety_alarms.json"


def load_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return deepcopy(fallback)
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(data, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def get_base_alarm_identifier(item: dict[str, Any]) -> str:
    source_payload = item.get("sourcePayload") or {}
    if not isinstance(source_payload, dict):
        source_payload = {}
    candidates = [
        item.get("alarmIdentifier"),
        item.get("identifier"),
        source_payload.get("F"),
        source_payload.get("Identifier"),
        source_payload.get("Identifikator"),
        source_payload.get("Abonnement"),
    ]
    for candidate in candidates:
        normalized = normalize_alarm_identifier(candidate)
        if normalized:
            return normalized
    return ""


def load_active_alarm_users(api_settings: dict[str, Any]) -> tuple[list[dict[str, Any]], Path]:
    path = derive_safety_alarms_file_path(api_settings)
    payload = load_json(path, {"schemaVersion": 1, "updatedAt": "", "items": []})
    items = payload.get("items") or []
    if not isinstance(items, list):
        return [], path
    active_items = [item for item in items if isinstance(item, dict) and item.get("isActive") is not False]
    return active_items, path


def first_matching_key(row: dict[str, str], aliases: list[str]) -> str:
    normalized = {normalize_header(key): key for key in row.keys()}
    for alias in aliases:
        if alias in normalized:
            return normalized[alias]
    return ""


def detect_header_row(rows: list[list[str]]) -> int:
    for index, row in enumerate(rows):
        normalized = {normalize_header(value) for value in row if normalize_text(value)}
        if any(alias in normalized for alias in HEARTBEAT_ALIASES):
            return index
    raise RuntimeError("Could not detect header row in report 119.")


def rows_to_records(rows: list[list[str]]) -> list[dict[str, str]]:
    header_index = detect_header_row(rows)
    headers = [normalize_text(value) for value in rows[header_index]]
    records: list[dict[str, str]] = []
    for row in rows[header_index + 1 :]:
        record = {}
        for idx, header in enumerate(headers):
            if not header:
                continue
            value = normalize_text(row[idx] if idx < len(row) else "")
            record[header] = value
        if any(value for value in record.values()):
            records.append(record)
    return records


def heartbeat_item_from_record(record: dict[str, str], imported_at: str) -> dict[str, Any] | None:
    identifier_key = first_matching_key(record, IDENTIFIER_ALIASES)
    apartment_key = first_matching_key(record, APARTMENT_ALIASES)
    heartbeat_key = first_matching_key(record, HEARTBEAT_ALIASES)

    alarm_identifier = normalize_alarm_identifier(record.get(identifier_key, ""))
    if not alarm_identifier:
        return None

    return {
        "alarmIdentifier": alarm_identifier,
        "apartmentLabel": normalize_text(record.get(apartment_key, "")),
        "lastHeartbeatAt": normalize_text(record.get(heartbeat_key, "")),
        "heartbeatSourceImportedAt": imported_at,
        "raw": record,
    }


def merge_heartbeat_items(current_items: list[dict[str, Any]], imported_items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    current_lookup = {
        normalize_alarm_identifier(item.get("alarmIdentifier")): deepcopy(item)
        for item in current_items
        if normalize_alarm_identifier(item.get("alarmIdentifier"))
    }
    next_lookup: dict[str, dict[str, Any]] = {}
    created = 0
    updated = 0

    for imported in imported_items:
        key = normalize_alarm_identifier(imported.get("alarmIdentifier"))
        if not key:
            continue
        existing = current_lookup.get(key)
        if existing is None:
            next_lookup[key] = imported
            created += 1
            continue
        next_lookup[key] = imported
        if existing != imported:
            updated += 1

    pruned = max(len(current_lookup) - len(next_lookup), 0)
    items = sorted(
        next_lookup.values(),
        key=lambda item: (
            normalize_text(item.get("apartmentLabel")).lower(),
            normalize_text(item.get("alarmIdentifier")).lower(),
        ),
    )
    return items, {"created": created, "updated": updated, "pruned": pruned, "total": len(items)}


def dedupe_heartbeat_items_by_identifier(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    lookup: dict[str, dict[str, Any]] = {}
    duplicate_rows = 0
    for item in items:
        key = normalize_alarm_identifier(item.get("alarmIdentifier"))
        if not key:
            continue
        if key in lookup:
            duplicate_rows += 1
        lookup[key] = item
    deduped = sorted(
        lookup.values(),
        key=lambda item: (
            normalize_text(item.get("apartmentLabel")).lower(),
            normalize_text(item.get("alarmIdentifier")).lower(),
        ),
    )
    return deduped, duplicate_rows


def filter_heartbeat_items_to_active_users(
    imported_items: list[dict[str, Any]],
    active_alarm_items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    active_identifiers = {
        identifier
        for identifier in (get_base_alarm_identifier(item) for item in active_alarm_items)
        if identifier
    }
    filtered_items = [
        item for item in imported_items if normalize_alarm_identifier(item.get("alarmIdentifier")) in active_identifiers
    ]
    deduped_items, duplicate_rows = dedupe_heartbeat_items_by_identifier(filtered_items)
    matched_identifiers = {
        normalize_alarm_identifier(item.get("alarmIdentifier"))
        for item in deduped_items
        if normalize_alarm_identifier(item.get("alarmIdentifier"))
    }
    stats = {
        "activeUsers": len(active_alarm_items),
        "activeIdentifiers": len(active_identifiers),
        "matchedRows": len(filtered_items),
        "matchedUnique": len(deduped_items),
        "unmatchedRows": max(len(imported_items) - len(filtered_items), 0),
        "duplicateRows": duplicate_rows,
        "missingHeartbeat": max(len(active_identifiers) - len(matched_identifiers), 0),
    }
    return deduped_items, stats


def resolve_xlsx_path(args: argparse.Namespace, api_settings: dict[str, Any]) -> Path:
    if args.xlsx:
        path = Path(args.xlsx).resolve()
        if not path.exists():
            raise FileNotFoundError(f"Could not find xlsx file: {path}")
        return path
    if not args.download:
        raise ValueError("Use either --xlsx <file> or --download.")
    token = login_and_get_token(api_settings)
    file_name = generate_report_filename(token, api_settings)
    return download_report_file(token, file_name, Path(args.output_dir).resolve(), api_settings)


def main() -> int:
    args = parse_args()
    settings_payload = load_workspace_settings(Path(args.settings_file).resolve())
    workspace = resolve_workspace_from_settings(settings_payload, args.workspace_id, args.workspace_name)

    api_settings = hydrate_api_settings_from_workspace(workspace)
    api_settings["reportId"] = REPORT_ID

    xlsx_path = resolve_xlsx_path(args, api_settings)
    rows = read_xlsx_rows(xlsx_path)
    records = rows_to_records(rows)
    imported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    imported_items = [
        item
        for item in (heartbeat_item_from_record(record, imported_at) for record in records)
        if item is not None
    ]
    active_alarm_items, safety_alarms_file = load_active_alarm_users(api_settings)
    matched_imported_items, match_stats = filter_heartbeat_items_to_active_users(imported_items, active_alarm_items)

    heartbeat_file = derive_heartbeat_file_path(api_settings)
    current = load_json(heartbeat_file, {"schemaVersion": 1, "updatedAt": imported_at, "items": []})
    merged_items, stats = merge_heartbeat_items(current.get("items") or [], matched_imported_items)
    next_payload = {
        "schemaVersion": 1,
        "updatedAt": imported_at,
        "items": merged_items,
    }
    save_json(heartbeat_file, next_payload)

    print("Heartbeat import complete")
    print(f"- workspace: {api_settings.get('workspaceName')}")
    print(f"- reportId: {REPORT_ID}")
    print(f"- source rows: {len(records)}")
    print(f"- parsed heartbeat rows: {len(imported_items)}")
    print(f"- active alarm users: {match_stats['activeUsers']}")
    print(f"- active identifiers: {match_stats['activeIdentifiers']}")
    print(f"- matched heartbeat rows: {match_stats['matchedRows']}")
    print(f"- matched unique users: {match_stats['matchedUnique']}")
    print(f"- unmatched heartbeat rows: {match_stats['unmatchedRows']}")
    print(f"- duplicate heartbeat rows: {match_stats['duplicateRows']}")
    print(f"- active users missing heartbeat: {match_stats['missingHeartbeat']}")
    print(f"- created: {stats['created']}")
    print(f"- updated: {stats['updated']}")
    print(f"- pruned old cache rows: {stats['pruned']}")
    print(f"- total cache items: {stats['total']}")
    print(f"- saved local cache: {heartbeat_file}")
    print(f"- matched against base file: {safety_alarms_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
