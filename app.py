
import csv
import io
import logging
import os
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher

import requests
from flask import Flask, jsonify, render_template, request, Response

# ============================================================
# WEATHERWORLD - GLOBAL WEATHER DASHBOARD
# Flask + SQLite + Open-Meteo + OpenStreetMap
# ============================================================

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("weatherworld")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, "weather_history.db")

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

HTTP_TIMEOUT = 20
WEATHER_CACHE_SECONDS = 300
GEOCODING_CACHE_SECONDS = 3600
AIR_CACHE_SECONDS = 600

HTTP = requests.Session()
HTTP.headers.update({
    "User-Agent": "WeatherWorldDashboard/2.0",
    "Accept": "application/json",
})

_cache = {}
_cache_lock = threading.Lock()
_db_lock = threading.RLock()
_nominatim_lock = threading.Lock()
_last_nominatim_request = 0.0


# ============================================================
# Country aliases
# ============================================================

COUNTRIES = {
    "india": ("IN", "India"),
    "bharat": ("IN", "India"),
    "united states": ("US", "United States"),
    "united states of america": ("US", "United States"),
    "usa": ("US", "United States"),
    "us": ("US", "United States"),
    "america": ("US", "United States"),
    "united kingdom": ("GB", "United Kingdom"),
    "uk": ("GB", "United Kingdom"),
    "great britain": ("GB", "United Kingdom"),
    "britain": ("GB", "United Kingdom"),
    "england": ("GB", "United Kingdom"),
    "australia": ("AU", "Australia"),
    "canada": ("CA", "Canada"),
    "new zealand": ("NZ", "New Zealand"),
    "singapore": ("SG", "Singapore"),
    "japan": ("JP", "Japan"),
    "china": ("CN", "China"),
    "pakistan": ("PK", "Pakistan"),
    "bangladesh": ("BD", "Bangladesh"),
    "sri lanka": ("LK", "Sri Lanka"),
    "nepal": ("NP", "Nepal"),
    "bhutan": ("BT", "Bhutan"),
    "maldives": ("MV", "Maldives"),
    "indonesia": ("ID", "Indonesia"),
    "malaysia": ("MY", "Malaysia"),
    "thailand": ("TH", "Thailand"),
    "vietnam": ("VN", "Vietnam"),
    "philippines": ("PH", "Philippines"),
    "south korea": ("KR", "South Korea"),
    "korea": ("KR", "South Korea"),
    "north korea": ("KP", "North Korea"),
    "germany": ("DE", "Germany"),
    "france": ("FR", "France"),
    "italy": ("IT", "Italy"),
    "spain": ("ES", "Spain"),
    "portugal": ("PT", "Portugal"),
    "netherlands": ("NL", "Netherlands"),
    "belgium": ("BE", "Belgium"),
    "switzerland": ("CH", "Switzerland"),
    "austria": ("AT", "Austria"),
    "sweden": ("SE", "Sweden"),
    "norway": ("NO", "Norway"),
    "denmark": ("DK", "Denmark"),
    "finland": ("FI", "Finland"),
    "ireland": ("IE", "Ireland"),
    "poland": ("PL", "Poland"),
    "ukraine": ("UA", "Ukraine"),
    "russia": ("RU", "Russia"),
    "turkey": ("TR", "Türkiye"),
    "turkiye": ("TR", "Türkiye"),
    "united arab emirates": ("AE", "United Arab Emirates"),
    "uae": ("AE", "United Arab Emirates"),
    "saudi arabia": ("SA", "Saudi Arabia"),
    "qatar": ("QA", "Qatar"),
    "oman": ("OM", "Oman"),
    "kuwait": ("KW", "Kuwait"),
    "bahrain": ("BH", "Bahrain"),
    "israel": ("IL", "Israel"),
    "egypt": ("EG", "Egypt"),
    "south africa": ("ZA", "South Africa"),
    "nigeria": ("NG", "Nigeria"),
    "kenya": ("KE", "Kenya"),
    "ghana": ("GH", "Ghana"),
    "ethiopia": ("ET", "Ethiopia"),
    "morocco": ("MA", "Morocco"),
    "algeria": ("DZ", "Algeria"),
    "brazil": ("BR", "Brazil"),
    "argentina": ("AR", "Argentina"),
    "chile": ("CL", "Chile"),
    "colombia": ("CO", "Colombia"),
    "mexico": ("MX", "Mexico"),
    "peru": ("PE", "Peru"),
    "cuba": ("CU", "Cuba"),
    "jamaica": ("JM", "Jamaica"),
}

PLACE_ALIASES = {
    "bangalore": ["Bengaluru"],
    "bengaluru": ["Bangalore"],
    "bombay": ["Mumbai"],
    "mumbai": ["Bombay"],
    "madras": ["Chennai"],
    "chennai": ["Madras"],
    "calcutta": ["Kolkata"],
    "kolkata": ["Calcutta"],
    "baroda": ["Vadodara"],
    "vadodara": ["Baroda"],
    "cochin": ["Kochi"],
    "kochi": ["Cochin"],
    "trivandrum": ["Thiruvananthapuram"],
    "mysore": ["Mysuru"],
    "poona": ["Pune"],
    "allahabad": ["Prayagraj"],
    "gurgaon": ["Gurugram"],
    "vizag": ["Visakhapatnam"],
    "cuddapah": ["Kadapa"],
    "kadapa": ["Cuddapah"],
}


# ============================================================
# General helpers
# ============================================================

def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(value):
    value = str(value or "").strip().lower()
    value = unicodedata.normalize("NFKD", value)
    value = "".join(
        char for char in value
        if not unicodedata.combining(char)
    )
    return " ".join(value.replace(",", " ").split())


def country_from_text(value):
    return COUNTRIES.get(normalize_text(value))


def cached_get_json(url, params=None, ttl=300):
    params = params or {}
    key = (url, tuple(sorted(params.items())))

    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.time():
            return cached[1]

    response = HTTP.get(
        url,
        params=params,
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    result = response.json()

    with _cache_lock:
        _cache[key] = (time.time() + ttl, result)

    return result


def split_location_query(query, country=""):
    query = str(query or "").strip()
    country = str(country or "").strip()

    country_code = None
    country_name = None

    if country:
        known_country = country_from_text(country)
        if known_country:
            country_code, country_name = known_country
        else:
            country_name = country

    parts = [part.strip() for part in query.split(",") if part.strip()]
    search_name = query

    if len(parts) >= 2:
        possible_country = country_from_text(parts[-1])
        if possible_country:
            country_code, country_name = possible_country
            search_name = ", ".join(parts[:-1])

    query_country = country_from_text(query)
    if query_country:
        country_code, country_name = query_country
        search_name = country_name

    return search_name.strip(), country_code, country_name


def make_queries(query, country_name=None):
    query = str(query or "").strip()
    if not query:
        return []

    search_name, _, parsed_country = split_location_query(query)
    country_name = country_name or parsed_country

    candidates = [query, search_name]

    alias_key = normalize_text(search_name)
    for alias in PLACE_ALIASES.get(alias_key, []):
        candidates.append(alias)
        if country_name:
            candidates.append(f"{alias}, {country_name}")

    if country_name and search_name:
        candidates.append(f"{search_name}, {country_name}")

    output = []
    seen = set()

    for item in candidates:
        item = item.strip()
        key = normalize_text(item)
        if key and key not in seen:
            output.append(item)
            seen.add(key)

    return output[:8]


def normalize_open_meteo_place(place):
    return {
        "id": place.get("id"),
        "name": place.get("name", "Unknown location"),
        "latitude": float(place["latitude"]),
        "longitude": float(place["longitude"]),
        "country": place.get("country", ""),
        "country_code": str(place.get("country_code", "")).upper(),
        "admin1": place.get("admin1", ""),
        "admin2": place.get("admin2", ""),
        "timezone": place.get("timezone", ""),
        "population": place.get("population"),
        "source": "Open-Meteo",
    }


def normalize_osm_place(place):
    address = place.get("address") or {}

    name = (
        place.get("name")
        or address.get("village")
        or address.get("town")
        or address.get("city")
        or address.get("hamlet")
        or address.get("municipality")
        or place.get("display_name", "").split(",")[0]
        or "Unknown location"
    )

    return {
        "id": place.get("place_id"),
        "name": name,
        "latitude": float(place["lat"]),
        "longitude": float(place["lon"]),
        "country": address.get("country", ""),
        "country_code": str(address.get("country_code", "")).upper(),
        "admin1": (
            address.get("state")
            or address.get("region")
            or address.get("state_district")
            or ""
        ),
        "admin2": (
            address.get("county")
            or address.get("district")
            or address.get("city_district")
            or ""
        ),
        "timezone": "",
        "source": "OpenStreetMap",
        "display_name": place.get("display_name", ""),
    }


def deduplicate_locations(locations):
    output = []
    seen = set()

    for item in locations:
        try:
            lat = round(float(item["latitude"]), 4)
            lon = round(float(item["longitude"]), 4)
        except (ValueError, TypeError, KeyError):
            continue

        key = (lat, lon)
        if key in seen:
            continue

        seen.add(key)
        output.append(item)

    return output


def location_score(place, query, country_code=None):
    name = normalize_text(place.get("name"))
    query = normalize_text(query)
    score = 0

    if name == query:
        score += 100
    elif name.startswith(query):
        score += 70
    elif query and query in name:
        score += 45
    else:
        score += int(SequenceMatcher(None, name, query).ratio() * 25)

    if country_code and place.get("country_code", "").upper() == country_code.upper():
        score += 100

    population = place.get("population")
    try:
        score += min(int(population or 0) // 100000, 15)
    except (ValueError, TypeError):
        pass

    return score


# ============================================================
# SQLite: robust initialization and schema migration
# ============================================================

def get_db():
    connection = sqlite3.connect(DATABASE, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 20000")
    return connection


def table_exists(connection, table_name):
    result = connection.execute("""
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = ?
    """, (table_name,)).fetchone()
    return result is not None


def get_columns(connection, table_name):
    if not table_exists(connection, table_name):
        return set()

    rows = connection.execute(
        f'PRAGMA table_info("{table_name}")'
    ).fetchall()

    return {row["name"] for row in rows}


def add_missing_columns(connection, table_name, definitions):
    """
    Add missing columns without deleting the user's existing database.

    Definitions must use fixed internal SQL column definitions, not user input.
    """
    existing = get_columns(connection, table_name)

    for column, definition in definitions.items():
        if column not in existing:
            connection.execute(
                f'ALTER TABLE "{table_name}" ADD COLUMN "{column}" {definition}'
            )


def init_db():
    """
    Initialize or upgrade the database.

    Crucially, this does not assume an existing database has the latest
    schema. Indexes are created only after the relevant columns exist.
    """
    with _db_lock:
        connection = get_db()

        try:
            connection.execute("PRAGMA journal_mode = WAL")

            connection.execute("""
                CREATE TABLE IF NOT EXISTS weather_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT DEFAULT '',
                    country TEXT DEFAULT '',
                    country_code TEXT DEFAULT '',
                    admin1 TEXT DEFAULT '',
                    latitude REAL,
                    longitude REAL,
                    searched_at TEXT DEFAULT ''
                )
            """)

            connection.execute("""
                CREATE TABLE IF NOT EXISTS favorites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT DEFAULT '',
                    country TEXT DEFAULT '',
                    country_code TEXT DEFAULT '',
                    admin1 TEXT DEFAULT '',
                    latitude REAL,
                    longitude REAL,
                    created_at TEXT DEFAULT ''
                )
            """)

            # Migrate older versions of weather_history.db in place.
            add_missing_columns(connection, "weather_history", {
                "name": "TEXT DEFAULT ''",
                "country": "TEXT DEFAULT ''",
                "country_code": "TEXT DEFAULT ''",
                "admin1": "TEXT DEFAULT ''",
                "latitude": "REAL",
                "longitude": "REAL",
                "searched_at": "TEXT DEFAULT ''",
            })

            add_missing_columns(connection, "favorites", {
                "name": "TEXT DEFAULT ''",
                "country": "TEXT DEFAULT ''",
                "country_code": "TEXT DEFAULT ''",
                "admin1": "TEXT DEFAULT ''",
                "latitude": "REAL",
                "longitude": "REAL",
                "created_at": "TEXT DEFAULT ''",
            })

            # Preserve data from common column names in older schemas.
            history_columns = get_columns(connection, "weather_history")

            if "city" in history_columns:
                connection.execute("""
                    UPDATE weather_history
                    SET name = city
                    WHERE (name IS NULL OR name = '')
                      AND city IS NOT NULL
                """)

            if "location" in history_columns:
                connection.execute("""
                    UPDATE weather_history
                    SET name = location
                    WHERE (name IS NULL OR name = '')
                      AND location IS NOT NULL
                """)

            if "timestamp" in history_columns:
                connection.execute("""
                    UPDATE weather_history
                    SET searched_at = timestamp
                    WHERE (searched_at IS NULL OR searched_at = '')
                      AND timestamp IS NOT NULL
                """)

            if "search_time" in history_columns:
                connection.execute("""
                    UPDATE weather_history
                    SET searched_at = search_time
                    WHERE (searched_at IS NULL OR searched_at = '')
                      AND search_time IS NOT NULL
                """)

            favorites_columns = get_columns(connection, "favorites")

            if "city" in favorites_columns:
                connection.execute("""
                    UPDATE favorites
                    SET name = city
                    WHERE (name IS NULL OR name = '')
                      AND city IS NOT NULL
                """)

            # Backfill blanks so the frontend gets consistent fields.
            connection.execute("""
                UPDATE weather_history
                SET name = 'Unknown location'
                WHERE name IS NULL OR name = ''
            """)

            connection.execute("""
                UPDATE weather_history
                SET searched_at = ?
                WHERE searched_at IS NULL OR searched_at = ''
            """, (utc_now(),))

            connection.execute("""
                UPDATE favorites
                SET name = 'Saved location'
                WHERE name IS NULL OR name = ''
            """)

            connection.execute("""
                UPDATE favorites
                SET created_at = ?
                WHERE created_at IS NULL OR created_at = ''
            """, (utc_now(),))

            # Create indexes only after migration guarantees the columns exist.
            history_columns = get_columns(connection, "weather_history")
            if "searched_at" in history_columns:
                connection.execute("""
                    CREATE INDEX IF NOT EXISTS idx_weather_history_time
                    ON weather_history(searched_at DESC)
                """)

            favorite_columns = get_columns(connection, "favorites")
            if "latitude" in favorite_columns and "longitude" in favorite_columns:
                connection.execute("""
                    CREATE INDEX IF NOT EXISTS idx_favorites_coordinates
                    ON favorites(latitude, longitude)
                """)

            connection.commit()
            logger.info("SQLite database initialized successfully: %s", DATABASE)

        except sqlite3.Error:
            connection.rollback()
            logger.exception("Database initialization failed")
            raise
        finally:
            connection.close()


def record_search(location):
    with _db_lock:
        connection = get_db()

        try:
            connection.execute("""
                INSERT INTO weather_history
                    (name, country, country_code, admin1,
                     latitude, longitude, searched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                location.get("name", "Unknown location"),
                location.get("country", ""),
                location.get("country_code", ""),
                location.get("admin1", ""),
                location.get("latitude"),
                location.get("longitude"),
                utc_now(),
            ))

            connection.execute("""
                DELETE FROM weather_history
                WHERE id NOT IN (
                    SELECT id FROM weather_history
                    ORDER BY searched_at DESC, id DESC
                    LIMIT 100
                )
            """)

            connection.commit()
        finally:
            connection.close()


def row_location(row):
    return {
        "id": row["id"],
        "name": row["name"] or "Unknown location",
        "country": row["country"] or "",
        "country_code": row["country_code"] or "",
        "admin1": row["admin1"] or "",
        "latitude": row["latitude"],
        "longitude": row["longitude"],
    }


# ============================================================
# Location search providers
# ============================================================

def search_open_meteo(query, country_code=None):
    params = {
        "name": query,
        "count": 10,
        "language": "en",
        "format": "json",
    }

    if country_code:
        params["countryCode"] = country_code.upper()

    try:
        data = cached_get_json(
            GEOCODING_URL,
            params,
            GEOCODING_CACHE_SECONDS,
        )

        places = [
            normalize_open_meteo_place(item)
            for item in (data.get("results") or [])
        ]

        if country_code:
            places = [
                item for item in places
                if item["country_code"] == country_code.upper()
            ]

        return places

    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        logger.warning("Open-Meteo search failed for %s: %s", query, exc)
        return []


def search_nominatim(query, country_code=None):
    global _last_nominatim_request

    params = {
        "q": query,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": 10,
        "accept-language": "en",
    }

    if country_code:
        params["countrycodes"] = country_code.lower()

    try:
        # Respect the public Nominatim service's request rate limit.
        with _nominatim_lock:
            elapsed = time.time() - _last_nominatim_request
            if elapsed < 1.1:
                time.sleep(1.1 - elapsed)

            response = HTTP.get(
                NOMINATIM_URL,
                params=params,
                timeout=HTTP_TIMEOUT,
            )
            _last_nominatim_request = time.time()

        response.raise_for_status()

        places = [
            normalize_osm_place(item)
            for item in response.json()
            if item.get("lat") is not None and item.get("lon") is not None
        ]

        if country_code:
            places = [
                item for item in places
                if item["country_code"] == country_code.upper()
            ]

        return places

    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        logger.warning("OpenStreetMap search failed for %s: %s", query, exc)
        return []


def search_locations(query, country=""):
    query = str(query or "").strip()
    country = str(country or "").strip()

    if not query:
        return []

    if len(query) > 120:
        query = query[:120].strip()

    search_name, country_code, country_name = split_location_query(query, country)

    if not country_code and country:
        found_country = country_from_text(country)
        if found_country:
            country_code, country_name = found_country

    queries = make_queries(search_name or query, country_name)
    all_results = []

    # Open-Meteo is the primary geocoding service.
    for candidate in queries[:6]:
        results = search_open_meteo(candidate, country_code)
        all_results.extend(results)

        if any(
            normalize_text(item["name"]) == normalize_text(search_name)
            for item in results
        ):
            break

    all_results = deduplicate_locations(all_results)

    exact_match = any(
        normalize_text(item["name"]) == normalize_text(search_name)
        for item in all_results
    )

    # Use OSM as a fallback for small towns, villages, and localities.
    if not all_results or (len(all_results) < 2 and not exact_match):
        for candidate in queries[:4]:
            results = search_nominatim(candidate, country_code)
            all_results.extend(results)

            if any(
                normalize_text(item["name"]) == normalize_text(search_name)
                for item in results
            ):
                break

    all_results = deduplicate_locations(all_results)

    # Enforce a requested country.
    if country_code:
        all_results = [
            item for item in all_results
            if item.get("country_code", "").upper() == country_code.upper()
        ]

    all_results.sort(
        key=lambda item: location_score(
            item, search_name or query, country_code
        ),
        reverse=True,
    )

    return all_results[:10]


# ============================================================
# Weather and air quality
# ============================================================

def fetch_weather(latitude, longitude):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": "auto",
        "forecast_days": 7,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "current": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "apparent_temperature",
            "is_day",
            "precipitation",
            "rain",
            "showers",
            "snowfall",
            "weather_code",
            "cloud_cover",
            "pressure_msl",
            "surface_pressure",
            "wind_speed_10m",
            "wind_direction_10m",
            "wind_gusts_10m",
        ]),
        "hourly": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "precipitation_probability",
            "precipitation",
            "weather_code",
            "wind_speed_10m",
            "wind_direction_10m",
        ]),
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "sunrise",
            "sunset",
            "uv_index_max",
            "precipitation_probability_max",
            "precipitation_sum",
            "wind_speed_10m_max",
        ]),
    }

    return cached_get_json(
        WEATHER_URL,
        params,
        WEATHER_CACHE_SECONDS,
    )


def fetch_air_quality(latitude, longitude):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": "auto",
        "forecast_days": 1,
        "current": ",".join([
            "us_aqi",
            "european_aqi",
            "pm10",
            "pm2_5",
            "carbon_monoxide",
            "nitrogen_dioxide",
            "sulphur_dioxide",
            "ozone",
        ]),
        "hourly": ",".join([
            "us_aqi",
            "european_aqi",
            "pm10",
            "pm2_5",
        ]),
    }

    return cached_get_json(
        AIR_QUALITY_URL,
        params,
        AIR_CACHE_SECONDS,
    )


def format_air_quality(data):
    if not data:
        return {
            "available": False,
            "current": {},
            "hourly": {},
            "error": "Air-quality data is currently unavailable.",
        }

    return {
        "available": bool(data.get("current")),
        "current": data.get("current") or {},
        "hourly": data.get("hourly") or {},
        "current_units": data.get("current_units") or {},
        "hourly_units": data.get("hourly_units") or {},
        "timezone": data.get("timezone", ""),
        "source": "Open-Meteo Air Quality",
    }


# ============================================================
# Pages and health
# ============================================================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def api_health():
    return jsonify({
        "status": "ok",
        "service": "WeatherWorld Dashboard",
        "timestamp": utc_now(),
    })


# ============================================================
# Search endpoint
# ============================================================

@app.route("/api/search")
def api_search():
    query = request.args.get("q", "").strip()
    country = request.args.get("country", "").strip()

    if not query:
        return jsonify({
            "results": [],
            "count": 0,
            "query": query,
        })

    try:
        results = search_locations(query, country)

        return jsonify({
            "results": results,
            "count": len(results),
            "query": query,
        })

    except Exception:
        logger.exception("Location search endpoint failed")
        return jsonify({
            "results": [],
            "count": 0,
            "query": query,
            "error": "Location search failed. Please try again.",
        }), 502


# ============================================================
# Weather endpoint
# ============================================================

@app.route("/api/weather")
def api_weather():
    latitude = request.args.get("latitude", type=float)
    longitude = request.args.get("longitude", type=float)

    if latitude is None or longitude is None:
        return jsonify({
            "error": "Both latitude and longitude are required."
        }), 400

    if not -90 <= latitude <= 90:
        return jsonify({"error": "Latitude must be between -90 and 90."}), 400

    if not -180 <= longitude <= 180:
        return jsonify({"error": "Longitude must be between -180 and 180."}), 400

    name = request.args.get("name", "Selected location").strip()
    country = request.args.get("country", "").strip()
    country_code = request.args.get("country_code", "").strip().upper()
    admin1 = request.args.get("admin1", "").strip()

    try:
        weather = fetch_weather(latitude, longitude)
    except requests.RequestException:
        logger.exception("Weather API request failed")
        return jsonify({
            "error": "Could not connect to the weather service. Check your internet connection."
        }), 502
    except (ValueError, KeyError, TypeError):
        logger.exception("Weather API response was invalid")
        return jsonify({
            "error": "The weather service returned invalid data."
        }), 502

    # AQI may fail independently; weather should still load.
    try:
        air_data = fetch_air_quality(latitude, longitude)
        air_quality = format_air_quality(air_data)
    except (requests.RequestException, ValueError, KeyError, TypeError):
        logger.warning("Air-quality service is temporarily unavailable")
        air_quality = format_air_quality(None)

    location = {
        "name": name or "Selected location",
        "country": country,
        "country_code": country_code,
        "admin1": admin1,
        "latitude": latitude,
        "longitude": longitude,
        "timezone": weather.get("timezone", ""),
        "timezone_abbreviation": weather.get("timezone_abbreviation", ""),
        "elevation": weather.get("elevation"),
    }

    try:
        record_search(location)
    except sqlite3.Error:
        # A history failure must not prevent current weather from appearing.
        logger.exception("Could not record weather history")

    return jsonify({
        "location": location,
        "current": weather.get("current") or {},
        "hourly": weather.get("hourly") or {},
        "daily": weather.get("daily") or {},
        "units": {
            "current": weather.get("current_units") or {},
            "hourly": weather.get("hourly_units") or {},
            "daily": weather.get("daily_units") or {},
        },
        "air_quality": air_quality,
        "source": "Open-Meteo",
        "updated_at": utc_now(),
    })


# ============================================================
# Search history endpoint
# ============================================================

@app.route("/api/history")
def api_history():
    limit = request.args.get("limit", default=20, type=int)
    limit = max(1, min(limit or 20, 100))

    with _db_lock:
        connection = get_db()

        try:
            rows = connection.execute("""
                SELECT id, name, country, country_code, admin1,
                       latitude, longitude, searched_at
                FROM weather_history
                ORDER BY searched_at DESC, id DESC
                LIMIT ?
            """, (limit,)).fetchall()
        finally:
            connection.close()

    history = []

    for row in rows:
        item = row_location(row)
        item["searched_at"] = row["searched_at"]
        history.append(item)

    return jsonify({
        "history": history,
        "count": len(history),
    })


# ============================================================
# CSV export endpoint
# ============================================================

@app.route("/api/export")
def api_export():
    with _db_lock:
        connection = get_db()

        try:
            rows = connection.execute("""
                SELECT name, country, country_code, admin1,
                       latitude, longitude, searched_at
                FROM weather_history
                ORDER BY searched_at DESC, id DESC
            """).fetchall()
        finally:
            connection.close()

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Location",
        "Country",
        "Country Code",
        "State or Region",
        "Latitude",
        "Longitude",
        "Searched At (UTC)",
    ])

    for row in rows:
        writer.writerow([
            row["name"],
            row["country"],
            row["country_code"],
            row["admin1"],
            row["latitude"],
            row["longitude"],
            row["searched_at"],
        ])

    return Response(
        "\ufeff" + output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition":
                'attachment; filename="weather-history.csv"'
        },
    )


# ============================================================
# Favorites: list
# ============================================================

@app.route("/api/favorites", methods=["GET"])
def api_get_favorites():
    with _db_lock:
        connection = get_db()

        try:
            rows = connection.execute("""
                SELECT id, name, country, country_code, admin1,
                       latitude, longitude, created_at
                FROM favorites
                ORDER BY created_at DESC, id DESC
            """).fetchall()
        finally:
            connection.close()

    favorites = []

    for row in rows:
        item = row_location(row)
        item["created_at"] = row["created_at"]
        favorites.append(item)

    return jsonify({
        "favorites": favorites,
        "count": len(favorites),
    })


# ============================================================
# Favorites: add
# ============================================================

@app.route("/api/favorites", methods=["POST"])
def api_add_favorite():
    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip() or "Saved location"
    country = str(data.get("country", "")).strip()
    country_code = str(data.get("country_code", "")).strip().upper()
    admin1 = str(data.get("admin1", "")).strip()

    try:
        latitude = float(data.get("latitude", data.get("lat")))
        longitude = float(data.get("longitude", data.get("lon")))
    except (ValueError, TypeError):
        return jsonify({
            "error": "Valid latitude and longitude are required."
        }), 400

    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return jsonify({"error": "Coordinates are outside valid ranges."}), 400

    with _db_lock:
        connection = get_db()

        try:
            existing = connection.execute("""
                SELECT id FROM favorites
                WHERE ABS(latitude - ?) < 0.001
                  AND ABS(longitude - ?) < 0.001
                LIMIT 1
            """, (latitude, longitude)).fetchone()

            if existing:
                return jsonify({
                    "success": True,
                    "message": "Location is already in favorites.",
                    "id": existing["id"],
                })

            cursor = connection.execute("""
                INSERT INTO favorites
                    (name, country, country_code, admin1,
                     latitude, longitude, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                name,
                country,
                country_code,
                admin1,
                latitude,
                longitude,
                utc_now(),
            ))

            connection.commit()

            return jsonify({
                "success": True,
                "message": "Favorite saved.",
                "id": cursor.lastrowid,
            }), 201

        except sqlite3.Error:
            connection.rollback()
            logger.exception("Could not save favorite")
            return jsonify({"error": "Could not save this favorite."}), 500

        finally:
            connection.close()


# ============================================================
# Favorites: delete
# ============================================================

@app.route("/api/favorites", methods=["DELETE"])
def api_delete_favorite():
    data = request.get_json(silent=True) or {}

    favorite_id = data.get("id")
    name = str(data.get("name", "")).strip()
    latitude = data.get("latitude", data.get("lat"))
    longitude = data.get("longitude", data.get("lon"))

    with _db_lock:
        connection = get_db()

        try:
            if favorite_id is not None:
                connection.execute(
                    "DELETE FROM favorites WHERE id = ?",
                    (favorite_id,),
                )

            elif latitude is not None and longitude is not None:
                try:
                    latitude = float(latitude)
                    longitude = float(longitude)
                except (ValueError, TypeError):
                    return jsonify({
                        "error": "Invalid coordinates."
                    }), 400

                connection.execute("""
                    DELETE FROM favorites
                    WHERE ABS(latitude - ?) < 0.001
                      AND ABS(longitude - ?) < 0.001
                """, (latitude, longitude))

            elif name:
                connection.execute(
                    "DELETE FROM favorites WHERE name = ?",
                    (name,),
                )

            else:
                return jsonify({
                    "error": "Provide a favorite ID or location coordinates."
                }), 400

            connection.commit()

            return jsonify({
                "success": True,
                "message": "Favorite removed if it existed.",
            })

        except sqlite3.Error:
            connection.rollback()
            logger.exception("Could not delete favorite")
            return jsonify({"error": "Could not remove this favorite."}), 500

        finally:
            connection.close()


# ============================================================
# Search diagnostics
# ============================================================

@app.route("/api/search-debug")
def api_search_debug():
    query = request.args.get("q", "").strip()

    if not query:
        return jsonify({"error": "Pass a query using ?q=..."}), 400

    search_name, country_code, country_name = split_location_query(query)
    queries = make_queries(search_name or query, country_name)

    attempts = []

    for candidate in queries[:4]:
        results = search_open_meteo(candidate, country_code)

        attempts.append({
            "query": candidate,
            "provider": "Open-Meteo",
            "count": len(results),
            "results": results[:5],
        })

        if not results:
            osm_results = search_nominatim(candidate, country_code)

            attempts.append({
                "query": candidate,
                "provider": "OpenStreetMap Nominatim",
                "count": len(osm_results),
                "results": osm_results[:5],
            })

    return jsonify({
        "query": query,
        "search_name": search_name,
        "country_code": country_code,
        "attempts": attempts,
    })


# ============================================================
# Initialize database and run
# ============================================================

# If initialization fails, the complete SQLite error is logged in the
# terminal rather than being silently ignored.
init_db()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    app.run(
        host="127.0.0.1",
        port=port,
        debug=debug,
        threaded=True,
    )
