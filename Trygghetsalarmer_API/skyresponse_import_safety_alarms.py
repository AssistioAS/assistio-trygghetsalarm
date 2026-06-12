import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


BASE_URL = os.getenv("SKYRESPONSE_BASE_URL", "https://hepro.skyresponse.com").rstrip("/")
USERNAME = os.getenv("SKYRESPONSE_USERNAME", "")
PASSWORD = os.getenv("SKYRESPONSE_PASSWORD", "")
GRANT_TYPE = "password"
REPORT_ID = int(os.getenv("SKYRESPONSE_SAFETY_REPORT_ID", "9"))
DOWNLOAD_RETRIES = int(os.getenv("SKYRESPONSE_DOWNLOAD_RETRIES", "8"))
DOWNLOAD_RETRY_SECONDS = float(os.getenv("SKYRESPONSE_DOWNLOAD_RETRY_SECONDS", "2"))
DEFAULT_SETTINGS_PATH = Path(
    os.getenv(
        "ASSISTIO_SETTINGS_PATH",
        str(Path.home() / "AppData" / "Roaming" / "no.svein.assistio-trygghetsalarm" / "settings.json"),
    )
)
DEFAULT_DATA_DIR = Path(
    os.getenv(
        "ASSISTIO_DATA_DIR",
        str(Path.home() / "Documents" / "Assistio-Trygghetsalarm"),
    )
)
POCKETBASE_URL = os.getenv("ASSISTIO_POCKETBASE_URL", "").strip()
POCKETBASE_WORKSPACE = os.getenv("ASSISTIO_POCKETBASE_WORKSPACE", "").strip()
POCKETBASE_AUTH_COLLECTION = os.getenv("ASSISTIO_POCKETBASE_AUTH_COLLECTION", "users").strip() or "users"
POCKETBASE_EMAIL = os.getenv("ASSISTIO_POCKETBASE_EMAIL", "").strip()
POCKETBASE_PASSWORD = os.getenv("ASSISTIO_POCKETBASE_PASSWORD", "")
POCKETBASE_TOKEN = os.getenv("ASSISTIO_POCKETBASE_TOKEN", "").strip()

DEFAULT_REPORT_PAYLOAD: dict[str, Any] = {
    "reportArguments": {
        "runMode": "BySearchCriteria",
        "exactMatch": False,
        "nameOnly": False,
        "entityIds": [],
        "searchText": "",
    },
    "outputFormat": "EXCEL",
    "reportId": REPORT_ID,
}

IMPORT_ONLY_FIELDS = {
    "externalId",
    "name",
    "address",
    "postalCode",
    "city",
    "phone",
    "nationalId",
    "dispatchGroup",
    "keyInfo",
    "isActive",
    "alarmStatus",
    "sourceImportedAt",
    "sourceRowHash",
    "sourcePayload",
    "sourceProvider",
}

PRESERVED_FIELDS = {
    "critical",
    "criticalNote",
    "keyBoxStatus",
    "keyBoxInstalledAt",
    "billingStatus",
    "notes",
    "personId",
    "personName",
    "requestId",
    "requestTitle",
    "taskId",
    "taskTitle",
    "processStatus",
}

HEADER_ALIASES = {
    "externalId": [
        "externalid",
        "id",
        "userid",
        "entityid",
        "customerid",
        "alarmid",
        "brukerid",
        "bruker_id",
        "kundeid",
        "objektid",
    ],
    "name": [
        "name",
        "fullname",
        "full_name",
        "bruker",
        "brukernavn",
        "customername",
        "nameofuser",
        "navn",
    ],
    "address": [
        "address",
        "street",
        "address1",
        "fulladdress",
        "brukeradresse",
        "customeraddress",
        "adresse",
    ],
    "phone": [
        "phone",
        "phonenumber",
        "mobile",
        "mobil",
        "telephone",
        "telefon",
        "telefonnummer",
        "mobilnummer",
    ],
    "alarmStatus": [
        "alarmstatus",
        "status",
        "unitstatus",
        "servicestatus",
        "accountstatus",
        "enhetstatus",
    ],
    "isActive": [
        "isactive",
        "active",
        "aktiv",
        "enabled",
        "inservice",
    ],
}

REPORT_COLUMN_MAPS = {
    5: {
        "name": "B",
        "dispatchGroup": "H",
        "isActive": "I",
    },
    9: {
        "name": "D",
        "keyInfo": "H",
        "nationalId": "U",
        "address": "Z",
        "postalCode": "AA",
        "city": "AB",
        "phone": "AG",
        "isActive": "BR",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import safety alarm users from Skyresponse xlsx into safety_alarms.json."
    )
    parser.add_argument("--xlsx", help="Use an existing xlsx file instead of downloading.")
    parser.add_argument("--download", action="store_true", help="Download the report before import.")
    parser.add_argument(
        "--output-dir",
        default="Trygghetsalarmer_API/downloads",
        help="Directory for downloaded reports.",
    )
    parser.add_argument("--data-file", default="", help="Target safety_alarms.json file.")
    parser.add_argument(
        "--settings-file",
        default=str(DEFAULT_SETTINGS_PATH),
        help="Path to settings.json.",
    )
    parser.add_argument("--workspace-id", default="", help="Use this workspace id from settings.json.")
    parser.add_argument("--workspace-name", default="", help="Use this workspace name from settings.json.")
    parser.add_argument(
        "--deactivate-missing",
        action="store_true",
        help="Mark imported-missing users inactive instead of leaving them untouched.",
    )
    return parser.parse_args()


def normalize_header(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("ae", "ae").replace("oe", "oe").replace("aa", "aa")
    text = text.replace("æ", "ae").replace("ø", "o").replace("å", "a")
    return re.sub(r"[^a-z0-9]+", "", text)


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


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


def bool_from_value(value: Any) -> bool | None:
    text = normalize_text(value).lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "ja", "active", "aktiv"}:
        return True
    if text in {"0", "false", "no", "nei", "inactive", "inaktiv", "disabled"}:
        return False
    return None


def status_from_value(value: Any) -> str:
    text = normalize_text(value).lower()
    if not text:
        return "unknown"
    if any(token in text for token in ["aktiv", "active", "install", "running", "ok"]):
        return "installed"
    if any(token in text for token in ["bestilt", "ordered", "pending"]):
        return "ordered"
    if any(token in text for token in ["pause", "hold"]):
        return "paused"
    if any(token in text for token in ["ended", "stopp", "avslutt", "inactive", "inaktiv"]):
        return "ended"
    return text[:80]


def load_workspace_settings(settings_path: Path) -> dict[str, Any]:
    if not settings_path.exists():
        return {}
    return json.loads(settings_path.read_text(encoding="utf-8-sig"))


def resolve_workspace_from_settings(
    settings_payload: dict[str, Any],
    workspace_id: str,
    workspace_name: str,
) -> dict[str, Any] | None:
    workspace_settings = settings_payload.get("workspaceSettings") or {}
    workspaces = workspace_settings.get("workspaces") or []
    if not isinstance(workspaces, list) or not workspaces:
        return None

    if workspace_id.strip():
        target = workspace_id.strip()
        return next((w for w in workspaces if str(w.get("id") or "").strip() == target), None)

    if workspace_name.strip():
        target = workspace_name.strip().lower()
        return next(
            (w for w in workspaces if str(w.get("name") or "").strip().lower() == target),
            None,
        )

    active_workspace_id = str(workspace_settings.get("activeWorkspaceId") or "").strip()
    if active_workspace_id:
        return next((w for w in workspaces if str(w.get("id") or "").strip() == active_workspace_id), None)
    return workspaces[0] if workspaces else None


def hydrate_api_settings_from_workspace(workspace: dict[str, Any] | None) -> dict[str, Any]:
    safety_settings = (workspace or {}).get("safetyAlarmImport") or {}
    report_id_raw = str(safety_settings.get("reportId") or REPORT_ID).strip()
    return {
        "baseUrl": str(safety_settings.get("baseUrl") or BASE_URL).strip().rstrip("/") or BASE_URL,
        "username": str(safety_settings.get("username") or USERNAME).strip(),
        "password": str(PASSWORD or safety_settings.get("password") or ""),
        "reportId": int(report_id_raw or REPORT_ID),
        "workspaceId": str((workspace or {}).get("id") or "").strip(),
        "workspaceName": str((workspace or {}).get("name") or "").strip(),
        "workspaceType": str((workspace or {}).get("type") or "local").strip(),
        "workspaceKey": str(POCKETBASE_WORKSPACE or (workspace or {}).get("workspaceKey") or "").strip(),
        "pocketbaseUrl": str(POCKETBASE_URL or (workspace or {}).get("baseUrl") or "").strip(),
        "authCollection": str(
            POCKETBASE_AUTH_COLLECTION or (workspace or {}).get("authCollection") or "users"
        ).strip() or "users",
        "dataFilePath": str((workspace or {}).get("dataFilePath") or "").strip(),
    }


def derive_data_file_path(args: argparse.Namespace, api_settings: dict[str, Any]) -> Path:
    if args.data_file:
        return Path(args.data_file).resolve()
    data_file_path = str(api_settings.get("dataFilePath") or "").strip()
    if data_file_path:
        return Path(data_file_path).resolve().with_name("safety_alarms.json")
    return DEFAULT_DATA_DIR / "safety_alarms.json"


def get_workspace_credentials(
    settings_payload: dict[str, Any],
    workspace_id: str,
) -> dict[str, Any] | None:
    if POCKETBASE_TOKEN:
        return {
            "email": POCKETBASE_EMAIL,
            "password": POCKETBASE_PASSWORD,
            "token": POCKETBASE_TOKEN,
        }
    if POCKETBASE_EMAIL and POCKETBASE_PASSWORD:
        return {
            "email": POCKETBASE_EMAIL,
            "password": POCKETBASE_PASSWORD,
            "token": POCKETBASE_TOKEN,
        }
    workspace_settings = settings_payload.get("workspaceSettings") or {}
    credentials = workspace_settings.get("workspaceCredentials") or []
    if not workspace_id or not isinstance(credentials, list):
        return None
    return next(
        (entry for entry in credentials if str(entry.get("workspaceId") or "").strip() == workspace_id),
        None,
    )


def login_and_get_token(api_settings: dict[str, Any]) -> str:
    base_url = str(api_settings["baseUrl"]).rstrip("/")
    username = str(api_settings["username"]).strip()
    password = str(api_settings["password"])
    if not username or not password:
        raise ValueError("Missing Skyresponse username or password in workspace settings.")

    response = requests.post(
        f"{base_url}/api/v2/token",
        data={"Username": username, "Password": password, "GrantType": GRANT_TYPE},
        timeout=60,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"Login succeeded but no access_token in response: {payload}")
    return token


def generate_report_filename(token: str, api_settings: dict[str, Any]) -> str:
    base_url = str(api_settings["baseUrl"]).rstrip("/")
    payload = deepcopy(DEFAULT_REPORT_PAYLOAD)
    payload["reportId"] = int(api_settings["reportId"])

    response = requests.post(
        f"{base_url}/api/v2/reports/generate",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=120,
    )
    response.raise_for_status()
    try:
        body = response.json()
    except ValueError:
        body = response.text.strip()

    if isinstance(body, str):
        filename = body.strip().strip('"')
    elif isinstance(body, dict):
        filename = body.get("fileName") or body.get("filename") or body.get("name")
    else:
        filename = ""

    if not filename:
        raise RuntimeError(f"Could not extract filename from generate response: {body}")
    return filename


def download_report_file(token: str, file_name: str, output_dir: Path, api_settings: dict[str, Any]) -> Path:
    base_url = str(api_settings["baseUrl"]).rstrip("/")
    url = f"{base_url}/api/v2/reports/download/{quote(file_name.strip(), safe='')}"
    headers = {"Authorization": f"Bearer {token}"}

    response: requests.Response | None = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        response = requests.get(url, headers=headers, timeout=300)
        if response.status_code < 400:
            break
        snippet = response.text[:500]
        is_not_ready = response.status_code == 404 and "FileNotFoundException" in snippet
        if is_not_ready and attempt < DOWNLOAD_RETRIES:
            print(
                f"Report not ready yet ({attempt}/{DOWNLOAD_RETRIES}). "
                f"Retrying in {DOWNLOAD_RETRY_SECONDS} seconds..."
            )
            time.sleep(DOWNLOAD_RETRY_SECONDS)
            continue
        response.raise_for_status()

    if response is None:
        raise RuntimeError("Download did not return a response.")

    try:
        body = response.json()
    except ValueError:
        body = None

    file_bytes = response.content
    resolved_name = file_name
    if isinstance(body, dict) and body.get("fileData"):
        resolved_name = body.get("fileName") or body.get("filename") or file_name
        file_bytes = base64.b64decode(body["fileData"], validate=False)

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / resolved_name
    try:
        target.write_bytes(file_bytes)
        return target
    except PermissionError:
        stem = target.stem
        suffix = target.suffix
        timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        fallback = output_dir / f"{stem}_{timestamp}{suffix}"
        fallback.write_bytes(file_bytes)
        print(f"Target file locked, saved as fallback: {fallback.name}")
        return fallback


def column_letter_to_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - 64)
    return max(value - 1, 0)


def shared_strings_from_zip(xlsx_path: Path) -> list[str]:
    with zipfile.ZipFile(xlsx_path) as archive:
        try:
            raw = archive.read("xl/sharedStrings.xml")
        except KeyError:
            return []

    root = ET.fromstring(raw)
    namespace = {"a": root.tag.split("}")[0].strip("{")}
    values: list[str] = []
    for si in root.findall("a:si", namespace):
        text_parts = [node.text or "" for node in si.findall(".//a:t", namespace)]
        values.append("".join(text_parts))
    return values


def first_sheet_path(xlsx_path: Path) -> str:
    with zipfile.ZipFile(xlsx_path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))

    ns_workbook = {"a": workbook.tag.split("}")[0].strip("{")}
    ns_rels = {"r": rels.tag.split("}")[0].strip("{")}
    sheet = workbook.find("a:sheets/a:sheet", ns_workbook)
    if sheet is None:
        raise RuntimeError("No worksheet found in xlsx file.")
    rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    for rel in rels.findall("r:Relationship", ns_rels):
        if rel.attrib.get("Id") == rel_id:
            target = str(rel.attrib["Target"]).replace("\\", "/").lstrip("/")
            return target if target.startswith("xl/") else f"xl/{target}"
    raise RuntimeError("Could not resolve worksheet target in workbook rels.")


def cell_value(cell: ET.Element, shared_strings: list[str], namespace: dict[str, str]) -> str:
    value_node = cell.find("a:v", namespace)
    if value_node is None:
        inline_text_nodes = cell.findall(".//a:is//a:t", namespace)
        if inline_text_nodes:
            return "".join(node.text or "" for node in inline_text_nodes)
        inline_text = cell.find("a:is/a:t", namespace)
        return inline_text.text if inline_text is not None and inline_text.text else ""
    raw = value_node.text or ""
    if cell.attrib.get("t") == "s":
        try:
            return shared_strings[int(raw)]
        except (ValueError, IndexError):
            return raw
    return raw


def read_xlsx_rows(xlsx_path: Path) -> list[list[str]]:
    shared_strings = shared_strings_from_zip(xlsx_path)
    sheet_path = first_sheet_path(xlsx_path)

    with zipfile.ZipFile(xlsx_path) as archive:
        sheet_root = ET.fromstring(archive.read(sheet_path))

    namespace = {"a": sheet_root.tag.split("}")[0].strip("{")}
    rows: list[list[str]] = []
    for row in sheet_root.findall(".//a:sheetData/a:row", namespace):
        values: list[str] = []
        for cell in row.findall("a:c", namespace):
            index = column_letter_to_index(cell.attrib.get("r", "A1"))
            while len(values) <= index:
                values.append("")
            values[index] = cell_value(cell, shared_strings, namespace).strip()
        rows.append(values)
    return rows


def read_xlsx_row_maps(xlsx_path: Path) -> list[dict[str, str]]:
    shared_strings = shared_strings_from_zip(xlsx_path)
    sheet_path = first_sheet_path(xlsx_path)

    with zipfile.ZipFile(xlsx_path) as archive:
        sheet_root = ET.fromstring(archive.read(sheet_path))

    namespace = {"a": sheet_root.tag.split("}")[0].strip("{")}
    rows: list[dict[str, str]] = []
    for row in sheet_root.findall(".//a:sheetData/a:row", namespace):
        row_map: dict[str, str] = {}
        for cell in row.findall("a:c", namespace):
            ref = str(cell.attrib.get("r", "")).upper()
            col = "".join(ch for ch in ref if ch.isalpha())
            if not col:
                continue
            value = cell_value(cell, shared_strings, namespace).strip()
            if value:
                row_map[col] = value
        rows.append(row_map)
    return rows


def find_header_and_records(rows: list[list[str]]) -> tuple[list[str], list[dict[str, str]]]:
    header_index = None
    header_values: list[str] = []
    max_matches = -1

    for index, row in enumerate(rows):
        normalized = [normalize_header(value) for value in row]
        match_count = sum(
            1 for value in normalized for aliases in HEADER_ALIASES.values() if value in aliases
        )
        if match_count > max_matches:
            max_matches = match_count
            header_index = index
            header_values = [normalize_text(value) for value in row]

    if header_index is None or max_matches <= 0:
        raise RuntimeError("Could not identify a valid header row in the xlsx file.")

    records: list[dict[str, str]] = []
    for row in rows[header_index + 1 :]:
        if not any(normalize_text(value) for value in row):
            continue
        record: dict[str, str] = {}
        for idx, header in enumerate(header_values):
            if not normalize_text(header):
                continue
            record[header] = normalize_text(row[idx] if idx < len(row) else "")
        records.append(record)
    return header_values, records


def match_field(record: dict[str, str], field_name: str) -> str:
    normalized_lookup = {normalize_header(key): value for key, value in record.items()}
    for alias in HEADER_ALIASES[field_name]:
        if alias in normalized_lookup:
            return normalized_lookup[alias]
    return ""


def field_from_column_map(row_map: dict[str, str], report_id: int, field_name: str) -> str:
    column_map = REPORT_COLUMN_MAPS.get(int(report_id), {})
    column = column_map.get(field_name)
    if not column:
        return ""
    return normalize_text(row_map.get(column, ""))


def stable_payload_hash(payload: dict[str, Any]) -> str:
    packed = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(packed.encode("utf-8")).hexdigest()


def normalize_import_record(
    row: dict[str, str],
    imported_at: str,
    report_id: int,
) -> dict[str, Any] | None:
    external_id = match_field(row, "externalId")
    if not external_id and report_id == 9:
        external_id = normalize_text(row.get("E", ""))
    name = field_from_column_map(row, report_id, "name") or match_field(row, "name")
    address = field_from_column_map(row, report_id, "address") or match_field(row, "address")
    postal_code = field_from_column_map(row, report_id, "postalCode")
    city = field_from_column_map(row, report_id, "city")
    phone = field_from_column_map(row, report_id, "phone") or match_field(row, "phone")
    national_id = field_from_column_map(row, report_id, "nationalId")
    dispatch_group = field_from_column_map(row, report_id, "dispatchGroup")
    key_info = field_from_column_map(row, report_id, "keyInfo")
    sender_identifier = normalize_alarm_identifier(row.get("F", ""))
    active_flag = bool_from_value(field_from_column_map(row, report_id, "isActive") or match_field(row, "isActive"))
    status_text = match_field(row, "alarmStatus")

    if external_id.lower() in {"bruker id", "externalid", "id"}:
        return None
    if name.strip().lower() in {"navn", "name"}:
        return None
    if report_id in {5, 9} and active_flag is False:
        return None
    if report_id == 9 and not sender_identifier:
        return None

    if report_id == 5:
        status_text = dispatch_group or status_text
    elif report_id == 9:
        status_text = "active" if active_flag else "inactive"

    import_payload = {
        "externalId": external_id,
        "name": name,
        "address": address,
        "postalCode": postal_code,
        "city": city,
        "phone": phone,
        "nationalId": national_id,
        "dispatchGroup": dispatch_group,
        "keyInfo": key_info,
        "isActive": True if active_flag is None else active_flag,
        "alarmStatus": status_from_value(status_text or ("active" if active_flag else "")),
        "sourceImportedAt": imported_at,
        "sourceProvider": "skyresponse",
        "sourcePayload": row,
    }
    import_payload["sourceRowHash"] = stable_payload_hash(import_payload)

    if not import_payload["externalId"] and not import_payload["name"]:
        return None
    return import_payload


def load_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return deepcopy(fallback)
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(data, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def existing_lookup_key(item: dict[str, Any]) -> str:
    external_id = normalize_text(item.get("externalId")).lower()
    if external_id:
        return f"id:{external_id}"
    return (
        f"name:{normalize_text(item.get('name')).lower()}"
        f"|addr:{normalize_text(item.get('address')).lower()}"
    )


def merge_imported_items(
    current_items: list[dict[str, Any]],
    imported_items: list[dict[str, Any]],
    deactivate_missing: bool,
    prune_missing: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    now_lookup = {existing_lookup_key(item): deepcopy(item) for item in current_items}
    imported_keys: set[str] = set()
    created = 0
    updated = 0

    for imported in imported_items:
        key = existing_lookup_key(imported)
        imported_keys.add(key)
        existing = now_lookup.get(key)
        if existing is None:
            new_item = {
                "id": imported.get("externalId") or imported.get("sourceRowHash"),
                "processStatus": "new",
                "critical": False,
                "criticalNote": "",
                "keyBoxStatus": "unknown",
                "keyBoxInstalledAt": None,
                "billingStatus": "not_ready",
                "notes": "",
                "personId": None,
                "personName": "",
                "requestId": None,
                "requestTitle": "",
                "taskId": None,
                "taskTitle": "",
                **imported,
                "createdAt": imported["sourceImportedAt"],
                "updatedAt": imported["sourceImportedAt"],
            }
            now_lookup[key] = new_item
            created += 1
            continue

        changed = False
        merged = deepcopy(existing)
        for field in IMPORT_ONLY_FIELDS:
            next_value = imported.get(field)
            if merged.get(field) != next_value:
                merged[field] = next_value
                changed = True
        for field in PRESERVED_FIELDS:
            if field not in merged:
                merged[field] = None if field.endswith("Id") or field.endswith("At") else ""
        if changed:
            merged["updatedAt"] = imported["sourceImportedAt"]
            now_lookup[key] = merged
            updated += 1

    deactivated = 0
    deleted = 0
    if prune_missing:
        for key, item in list(now_lookup.items()):
            if key in imported_keys:
                continue
            if normalize_text(item.get("sourceProvider")).lower() != "skyresponse":
                continue
            now_lookup.pop(key, None)
            deleted += 1

    if deactivate_missing:
        for key, item in list(now_lookup.items()):
            if key in imported_keys:
                continue
            if item.get("isActive") is False:
                continue
            item["isActive"] = False
            item["alarmStatus"] = item.get("alarmStatus") or "ended"
            item["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            now_lookup[key] = item
            deactivated += 1

    items = list(now_lookup.values())
    items.sort(
        key=lambda item: (
            not bool(item.get("critical")),
            not bool(item.get("isActive")),
            normalize_text(item.get("name")).lower(),
        )
    )
    return items, {
        "created": created,
        "updated": updated,
        "deactivated": deactivated,
        "deleted": deleted,
        "total": len(items),
    }


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
    workspace = resolve_workspace_from_settings(
        settings_payload=settings_payload,
        workspace_id=args.workspace_id,
        workspace_name=args.workspace_name,
    )
    api_settings = hydrate_api_settings_from_workspace(workspace)
    xlsx_path = resolve_xlsx_path(args, api_settings)
    imported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report_id = int(api_settings["reportId"])
    row_maps = read_xlsx_row_maps(xlsx_path)
    data_path = derive_data_file_path(args, api_settings)

    if api_settings["workspaceName"]:
        print(
            f"Workspace: {api_settings['workspaceName']}"
            + (f" ({api_settings['workspaceId']})" if api_settings["workspaceId"] else "")
        )
    print(f"Base URL: {api_settings['baseUrl']}")
    print(f"Report ID: {report_id}")
    print(f"Using xlsx: {xlsx_path}")
    print(f"Found {len(row_maps)} worksheet rows.")

    imported_items = []
    skipped = 0
    for row in row_maps:
        normalized = normalize_import_record(row, imported_at, report_id)
        if normalized is None:
            skipped += 1
            continue
        imported_items.append(normalized)

    prune_missing = report_id in {5, 9}
    effective_deactivate_missing = args.deactivate_missing and not prune_missing

    current = load_json(data_path, {"schemaVersion": 1, "updatedAt": imported_at, "items": []})
    merged_items, summary = merge_imported_items(
        current_items=current.get("items", []),
        imported_items=imported_items,
        deactivate_missing=effective_deactivate_missing,
        prune_missing=prune_missing,
    )
    next_data = {
        **current,
        "schemaVersion": int(current.get("schemaVersion", 1) or 1),
        "updatedAt": imported_at,
        "items": merged_items,
    }
    save_json(data_path, next_data)

    # Save meta.json with lastImportedAt
    meta_path = data_path.parent / "meta.json"
    meta_data = load_json(meta_path, {})
    meta_data["lastImportedAt"] = imported_at
    save_json(meta_path, meta_data)

    print("Import complete.")
    print(f"- valid rows: {len(imported_items)}")
    print(f"- skipped: {skipped}")
    print(f"- created: {summary['created']}")
    print(f"- updated: {summary['updated']}")
    print(f"- deactivated: {summary['deactivated']}")
    print(f"- deleted: {summary['deleted']}")
    print(f"- total in file: {summary['total']}")
    print(f"- saved to: {data_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
