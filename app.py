import csv
import io
import json
import logging
import math
import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import requests
from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("weatherworld")

DATABASE_PATH = os.getenv("DATABASE_PATH", "weather_history.db")

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

REQUEST_TIMEOUT = (5, 15)
GEOCODING_TTL = 86400
FORECAST_TTL = 1800
AIR_QUALITY_TTL = 3600
STALE_CACHE_TTL = 21600
DEFAULT_COOLDOWN = 120
MAX_COOLDOWN = 1800
MAX_CACHE_ENTRIES = 300

_cache = {}
_cache_lock = Lock()
_provider_lock = Lock()
_provider_cooldown_until = 0.0
_provider_cooldown_seconds = DEFAULT_COOLDOWN
_inflight_locks = {}
_inflight_lock = Lock()

http = requests.Session()
http.headers.update({
    "User-Agent": "WeatherWorld/6.0",
    "Accept": "application/json",
})

WEATHER_CODES = {
    0: ("Clear sky", "☀️"),
    1: ("Mainly clear", "🌤️"),
    2: ("Partly cloudy", "⛅"),
    3: ("Overcast", "☁️"),
    45: ("Fog", "🌫️"),
    48: ("Depositing rime fog", "🌫️"),
    51: ("Light drizzle", "🌦️"),
    53: ("Moderate drizzle", "🌦️"),
    55: ("Dense drizzle", "🌧️"),
    56: ("Light freezing drizzle", "🌧️"),
    57: ("Dense freezing drizzle", "🌧️"),
    61: ("Slight rain", "🌦️"),
    63: ("Moderate rain", "🌧️"),
    65: ("Heavy rain", "🌧️"),
    66: ("Light freezing rain", "🌧️"),
    67: ("Heavy freezing rain", "🌧️"),
    71: ("Slight snowfall", "🌨️"),
    73: ("Moderate snowfall", "🌨️"),
    75: ("Heavy snowfall", "❄️"),
    77: ("Snow grains", "🌨️"),
    80: ("Slight rain showers", "🌦️"),
    81: ("Moderate rain showers", "🌧️"),
    82: ("Violent rain showers", "⛈️"),
    85: ("Slight snow showers", "🌨️"),
    86: ("Heavy snow showers", "❄️"),
    95: ("Thunderstorm", "⛈️"),
    96: ("Thunderstorm with hail", "⛈️"),
    99: ("Thunderstorm with heavy hail", "⛈️"),
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------
# In-memory cache
# --------------------------------------------------

def cache_get(key, ttl=None, allow_stale=False):
    now = time.time()

    with _cache_lock:
        entry = _cache.get(key)

        if not entry:
            return None

        age = now - entry["saved_at"]
        max_age = ttl if ttl is not None else entry["ttl"]

        if age <= max_age:
            return {
                "data": entry["data"],
                "stale": False,
                "age": age,
            }

        if allow_stale and age <= STALE_CACHE_TTL:
            return {
                "data": entry["data"],
                "stale": True,
                "age": age,
            }

        return None


def cache_set(key, data, ttl):
    with _cache_lock:
        if len(_cache) >= MAX_CACHE_ENTRIES and key not in _cache:
            oldest = min(
                _cache,
                key=lambda item: _cache[item]["saved_at"],
            )
            _cache.pop(oldest, None)

        _cache[key] = {
            "data": data,
            "saved_at": time.time(),
            "ttl": ttl,
        }


def location_cache_key(latitude, longitude, extra=""):
    return (
        f"{round(float(latitude), 3)}:"
        f"{round(float(longitude), 3)}:{extra}"
    )


# --------------------------------------------------
# Persistent cache in SQLite
# --------------------------------------------------

@contextmanager
def database():
    if DATABASE_PATH != ":memory:":
        Path(DATABASE_PATH).expanduser().resolve().parent.mkdir(
            parents=True,
            exist_ok=True,
        )

    db = sqlite3.connect(DATABASE_PATH, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=20000")
    db.execute("PRAGMA foreign_keys=ON")

    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize_database():
    with database() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                country TEXT NOT NULL DEFAULT '',
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'auto',
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                country TEXT NOT NULL DEFAULT '',
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'auto',
                searched_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_history_searched_at
            ON search_history(searched_at)
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS provider_cache (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                saved_at REAL NOT NULL,
                ttl INTEGER NOT NULL
            )
        """)


def persistent_cache_get(key, ttl=None, allow_stale=False):
    try:
        with database() as db:
            row = db.execute(
                """
                SELECT payload, saved_at, ttl
                FROM provider_cache
                WHERE cache_key = ?
                """,
                (key,),
            ).fetchone()

        if not row:
            return None

        age = max(0, time.time() - row["saved_at"])
        max_age = ttl if ttl is not None else row["ttl"]

        if age <= max_age:
            return {
                "data": json.loads(row["payload"]),
                "stale": False,
                "age": age,
            }

        if allow_stale and age <= STALE_CACHE_TTL:
            return {
                "data": json.loads(row["payload"]),
                "stale": True,
                "age": age,
            }

    except (sqlite3.Error, ValueError, TypeError):
        logger.exception("Persistent cache read failed")

    return None


def persistent_cache_set(key, data, ttl):
    try:
        with database() as db:
            db.execute(
                """
                INSERT INTO provider_cache
                    (cache_key, payload, saved_at, ttl)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    saved_at = excluded.saved_at,
                    ttl = excluded.ttl
                """,
                (
                    key,
                    json.dumps(data, separators=(",", ":")),
                    time.time(),
                    ttl,
                ),
            )

            db.execute(
                "DELETE FROM provider_cache WHERE saved_at < ?",
                (time.time() - STALE_CACHE_TTL,),
            )

    except (sqlite3.Error, TypeError):
        logger.exception("Persistent cache write failed")


def get_cached(key, ttl, allow_stale=False):
    result = cache_get(key, ttl, allow_stale)

    if result is not None:
        return result

    result = persistent_cache_get(key, ttl, allow_stale)

    if result is not None:
        cache_set(key, result["data"], ttl)

    return result


def set_cached(key, data, ttl):
    cache_set(key, data, ttl)
    persistent_cache_set(key, data, ttl)


# --------------------------------------------------
# Open-Meteo cooldown and HTTP requests
# --------------------------------------------------

def provider_is_cooling_down():
    with _provider_lock:
        remaining = _provider_cooldown_until - time.time()
        return max(0, int(math.ceil(remaining)))


def start_provider_cooldown(retry_after=None):
    global _provider_cooldown_until
    global _provider_cooldown_seconds

    try:
        seconds = int(retry_after)
    except (TypeError, ValueError):
        seconds = _provider_cooldown_seconds

    seconds = max(1, min(seconds, MAX_COOLDOWN))

    with _provider_lock:
        _provider_cooldown_seconds = min(
            max(DEFAULT_COOLDOWN, _provider_cooldown_seconds * 2),
            MAX_COOLDOWN,
        )

        _provider_cooldown_until = max(
            _provider_cooldown_until,
            time.time() + seconds,
        )


def api_get_json(url, params):
    cooldown = provider_is_cooling_down()

    if cooldown:
        raise RuntimeError(
            f"Weather provider is cooling down. "
            f"Retry in about {cooldown} seconds."
        )

    try:
        response = http.get(
            url,
            params=params,
            timeout=REQUEST_TIMEOUT,
        )

    except requests.Timeout as exc:
        raise RuntimeError(
            "Weather provider timed out. Please retry shortly."
        ) from exc

    except requests.RequestException as exc:
        logger.warning("Provider request failed: %s", exc)
        raise RuntimeError(
            "Could not connect to the weather provider."
        ) from exc

    if response.status_code == 429:
        start_provider_cooldown(
            response.headers.get("Retry-After")
        )
        raise RuntimeError(
            "Weather provider rate limit reached. "
            "Please wait before retrying."
        )

    if response.status_code >= 500:
        raise RuntimeError(
            "Weather provider is temporarily unavailable."
        )

    try:
        response.raise_for_status()
        result = response.json()

    except requests.RequestException as exc:
        raise RuntimeError(
            "Weather provider rejected the request."
        ) from exc

    except ValueError as exc:
        raise RuntimeError(
            "Weather provider returned invalid JSON."
        ) from exc

    if not isinstance(result, dict):
        raise RuntimeError(
            "Weather provider returned an unexpected response."
        )

    return result


# --------------------------------------------------
# General helpers
# --------------------------------------------------

def clean_text(value, default="", max_length=150):
    if value is None:
        return default

    value = str(value).strip()
    return value[:max_length] if value else default


def parse_coordinate(value, field):
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"Please provide a valid {field}."
        ) from exc

    if not math.isfinite(number):
        raise ValueError(
            f"{field.capitalize()} must be finite."
        )

    if field == "latitude" and not -90 <= number <= 90:
        raise ValueError(
            "Latitude must be between -90 and 90."
        )

    if field == "longitude" and not -180 <= number <= 180:
        raise ValueError(
            "Longitude must be between -180 and 180."
        )

    return number


def location_from_args():
    return {
        "name": clean_text(
            request.args.get("name"),
            "Selected location",
        ),
        "country": clean_text(
            request.args.get("country"),
        ),
        "latitude": parse_coordinate(
            request.args.get("latitude"),
            "latitude",
        ),
        "longitude": parse_coordinate(
            request.args.get("longitude"),
            "longitude",
        ),
        "timezone": clean_text(
            request.args.get("timezone"),
            "auto",
            100,
        ),
    }


def error_response(message, status=400):
    return jsonify({"error": message}), status


def provider_error_status(message):
    lower = message.lower()

    if "rate limit" in lower or "cooling down" in lower:
        return 429

    if "timed out" in lower:
        return 504

    if "temporarily unavailable" in lower:
        return 503

    if "could not connect" in lower:
        return 502

    return 502


def weather_description(code):
    try:
        return WEATHER_CODES.get(
            int(code),
            ("Unknown conditions", "🌍"),
        )
    except (TypeError, ValueError):
        return ("Unknown conditions", "🌍")


# --------------------------------------------------
# Search history
# --------------------------------------------------

def remember_location(location):
    with database() as db:
        db.execute(
            """
            INSERT INTO search_history
                (name, country, latitude, longitude, timezone, searched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                location["name"],
                location.get("country", ""),
                location["latitude"],
                location["longitude"],
                location.get("timezone", "auto"),
                utc_now(),
            ),
        )

        db.execute("""
            DELETE FROM search_history
            WHERE id NOT IN (
                SELECT id FROM search_history
                ORDER BY searched_at DESC, id DESC
                LIMIT 200
            )
        """)


# --------------------------------------------------
# Current weather and forecast
# --------------------------------------------------

def get_current_weather(location):
    latitude = location["latitude"]
    longitude = location["longitude"]
    timezone_name = location.get("timezone", "auto")

    key = location_cache_key(
        latitude,
        longitude,
        f"forecast:{timezone_name}",
    )

    cached = get_cached(
        key,
        FORECAST_TTL,
        allow_stale=True,
    )

    if cached and not cached["stale"]:
        return cached["data"], False

    stale_data = cached["data"] if cached else None

    # Prevent simultaneous requests for the same location.
    with _inflight_lock:
        request_lock = _inflight_locks.setdefault(
            key,
            Lock(),
        )

    with request_lock:
        cached = get_cached(
            key,
            FORECAST_TTL,
            allow_stale=True,
        )

        if cached and not cached["stale"]:
            return cached["data"], False

        if cached:
            stale_data = cached["data"]

        try:
            data = api_get_json(
                FORECAST_URL,
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "timezone": timezone_name,
                    "forecast_days": 7,
                    "current": (
                        "temperature_2m,relative_humidity_2m,"
                        "apparent_temperature,is_day,precipitation,"
                        "weather_code,wind_speed_10m,wind_direction_10m,"
                        "surface_pressure"
                    ),
                    "hourly": (
                        "temperature_2m,relative_humidity_2m,"
                        "precipitation_probability,precipitation,"
                        "weather_code,wind_speed_10m"
                    ),
                    "daily": (
                        "weather_code,temperature_2m_max,"
                        "temperature_2m_min,sunrise,sunset,"
                        "uv_index_max,precipitation_sum,"
                        "precipitation_probability_max"
                    ),
                },
            )

            if not data.get("current"):
                raise RuntimeError(
                    "No current weather data was returned."
                )

            set_cached(key, data, FORECAST_TTL)
            return data, False

        except RuntimeError:
            if stale_data is not None:
                logger.warning(
                    "Using previously cached forecast for %s",
                    key,
                )
                return stale_data, True

            raise


# --------------------------------------------------
# Air quality
# --------------------------------------------------

def get_air_quality(location):
    latitude = location["latitude"]
    longitude = location["longitude"]

    key = location_cache_key(
        latitude,
        longitude,
        "air-quality",
    )

    cached = get_cached(
        key,
        AIR_QUALITY_TTL,
        allow_stale=True,
    )

    if cached and not cached["stale"]:
        return cached["data"], False

    stale_data = cached["data"] if cached else None

    try:
        data = api_get_json(
            AIR_QUALITY_URL,
            {
                "latitude": latitude,
                "longitude": longitude,
                "timezone": location.get("timezone", "auto"),
                "current": (
                    "european_aqi,us_aqi,pm10,pm2_5,"
                    "carbon_monoxide,nitrogen_dioxide,"
                    "sulphur_dioxide,ozone"
                ),
                "hourly": "pm10,pm2_5,us_aqi",
                "forecast_days": 1,
            },
        )

        set_cached(key, data, AIR_QUALITY_TTL)
        return data, False

    except RuntimeError:
        if stale_data is not None:
            logger.warning(
                "Using previously cached air-quality data."
            )
            return stale_data, True

        raise


# --------------------------------------------------
# Location search
# --------------------------------------------------

def get_geocoding_results(query):
    key = f"geocode:{query.casefold()}"

    cached = get_cached(
        key,
        GEOCODING_TTL,
        allow_stale=False,
    )

    if cached:
        return cached["data"]

    data = api_get_json(
        GEOCODING_URL,
        {
            "name": query,
            "count": 10,
            "language": "en",
            "format": "json",
        },
    )

    results = data.get("results", [])
    set_cached(key, results, GEOCODING_TTL)

    return results


def normalize_place(place):
    return {
        "name": clean_text(
            place.get("name"),
            "Unknown location",
        ),
        "country": clean_text(place.get("country")),
        "admin1": clean_text(place.get("admin1")),
        "latitude": place.get("latitude"),
        "longitude": place.get("longitude"),
        "timezone": clean_text(
            place.get("timezone"),
            "auto",
            100,
        ),
    }


# --------------------------------------------------
# Main page and health endpoints
# --------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "WeatherWorld",
        "timestamp": utc_now(),
    })


@app.route("/api/provider-health")
@app.route("/provider-health")
def provider_health():
    cooldown = provider_is_cooling_down()

    return jsonify({
        "status": "cooldown" if cooldown else "online",
        "provider": "Open-Meteo",
        "retry_after_seconds": cooldown,
        "message": (
            f"Provider cooldown: retry in {cooldown} seconds."
            if cooldown
            else "No recent rate-limit cooldown is active."
        ),
    })


# --------------------------------------------------
# Weather search endpoint
# --------------------------------------------------

@app.route("/api/search")
@app.route("/search")
def search_locations():
    query = clean_text(
        request.args.get("q"),
        max_length=100,
    )

    if len(query) < 2:
        return jsonify({"results": []})

    try:
        places = get_geocoding_results(query)

        results = [
            normalize_place(place)
            for place in places
            if isinstance(place, dict)
        ]

        return jsonify({"results": results})

    except RuntimeError as exc:
        message = str(exc)
        return error_response(
            message,
            provider_error_status(message),
        )


# --------------------------------------------------
# Weather API endpoint
# --------------------------------------------------

@app.route("/api/weather")
@app.route("/weather")
def weather():
    try:
        location = location_from_args()
    except ValueError as exc:
        return error_response(str(exc), 400)

    try:
        data, stale = get_current_weather(location)

        current = data.get("current", {})

        description, icon = weather_description(
            current.get("weather_code")
        )

        try:
            remember_location(location)
        except sqlite3.Error:
            logger.exception(
                "Could not save search history."
            )

        return jsonify({
            "location": location,
            "current": current,
            "hourly": data.get("hourly", {}),
            "daily": data.get("daily", {}),
            "timezone": data.get(
                "timezone",
                location["timezone"],
            ),
            "utc_offset_seconds": data.get(
                "utc_offset_seconds",
                0,
            ),
            "weather_description": description,
            "weather_icon": icon,
            "cached": stale,
            "updated_at": utc_now(),
            "source": "Open-Meteo",
        })

    except RuntimeError as exc:
        message = str(exc)
        return error_response(
            message,
            provider_error_status(message),
        )


# --------------------------------------------------
# Air-quality API endpoint
# --------------------------------------------------

@app.route("/api/air-quality")
@app.route("/air-quality")
def air_quality():
    try:
        location = location_from_args()
    except ValueError as exc:
        return error_response(str(exc), 400)

    try:
        data, stale = get_air_quality(location)

        return jsonify({
            "location": location,
            "current": data.get("current", {}),
            "hourly": data.get("hourly", {}),
            "cached": stale,
            "updated_at": utc_now(),
            "source": "Open-Meteo",
        })

    except RuntimeError as exc:
        message = str(exc)
        return error_response(
            message,
            provider_error_status(message),
        )


# --------------------------------------------------
# Favorites
# --------------------------------------------------

@app.route("/api/favorites", methods=["GET", "POST"])
@app.route("/favorites", methods=["GET", "POST"])
def favorites():
    if request.method == "GET":
        with database() as db:
            rows = db.execute("""
                SELECT *
                FROM favorites
                ORDER BY name COLLATE NOCASE
            """).fetchall()

        return jsonify({
            "results": [dict(row) for row in rows],
        })

    payload = request.get_json(silent=True) or {}

    try:
        location = {
            "name": clean_text(
                payload.get("name"),
                max_length=150,
            ),
            "country": clean_text(
                payload.get("country"),
            ),
            "latitude": parse_coordinate(
                payload.get("latitude"),
                "latitude",
            ),
            "longitude": parse_coordinate(
                payload.get("longitude"),
                "longitude",
            ),
            "timezone": clean_text(
                payload.get("timezone"),
                "auto",
                100,
            ),
        }

        if not location["name"]:
            raise ValueError(
                "Location name is required."
            )

    except ValueError as exc:
        return error_response(str(exc), 400)

    with database() as db:
        existing = db.execute(
            """
            SELECT id FROM favorites
            WHERE ABS(latitude - ?) < 0.0001
              AND ABS(longitude - ?) < 0.0001
            """,
            (
                location["latitude"],
                location["longitude"],
            ),
        ).fetchone()

        if existing:
            return jsonify({
                "message": "Location is already a favorite.",
                "id": existing["id"],
            })

        cursor = db.execute(
            """
            INSERT INTO favorites
                (name, country, latitude, longitude,
                 timezone, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                location["name"],
                location["country"],
                location["latitude"],
                location["longitude"],
                location["timezone"],
                utc_now(),
            ),
        )

        location["id"] = cursor.lastrowid

    return jsonify({
        "message": "Favorite saved.",
        "favorite": location,
    }), 201


@app.route(
    "/api/favorites/<int:favorite_id>",
    methods=["DELETE"],
)
@app.route(
    "/favorites/<int:favorite_id>",
    methods=["DELETE"],
)
def delete_favorite(favorite_id):
    with database() as db:
        cursor = db.execute(
            "DELETE FROM favorites WHERE id = ?",
            (favorite_id,),
        )

    if cursor.rowcount == 0:
        return error_response(
            "Favorite not found.",
            404,
        )

    return jsonify({
        "message": "Favorite removed.",
    })


# --------------------------------------------------
# Search history and CSV export
# --------------------------------------------------

@app.route("/api/history", methods=["GET", "DELETE"])
@app.route("/history", methods=["GET", "DELETE"])
def history():
    if request.method == "DELETE":
        with database() as db:
            db.execute("DELETE FROM search_history")

        return jsonify({
            "message": "Search history cleared.",
        })

    try:
        limit = int(request.args.get("limit", 50))
    except ValueError:
        limit = 50

    limit = max(1, min(limit, 200))

    with database() as db:
        rows = db.execute(
            """
            SELECT *
            FROM search_history
            ORDER BY searched_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return jsonify({
        "results": [dict(row) for row in rows],
    })


@app.route("/api/history/export")
@app.route("/export-history")
@app.route("/api/export")
def export_history():
    with database() as db:
        rows = db.execute("""
            SELECT name, country, latitude, longitude,
                   timezone, searched_at
            FROM search_history
            ORDER BY searched_at DESC
        """).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Name",
        "Country",
        "Latitude",
        "Longitude",
        "Timezone",
        "Searched At",
    ])

    for row in rows:
        writer.writerow(list(row))

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition":
                "attachment; filename=weather_history.csv",
        },
    )


# --------------------------------------------------
# Error handlers
# --------------------------------------------------

@app.errorhandler(404)
def not_found(_error):
    return jsonify({
        "error": "Endpoint not found.",
    }), 404


@app.errorhandler(413)
def too_large(_error):
    return jsonify({
        "error": "Request payload is too large.",
    }), 413


@app.errorhandler(500)
def internal_error(error):
    logger.error(
        "Unhandled application error: %s",
        error,
    )

    return jsonify({
        "error": "An internal server error occurred.",
    }), 500


# Initialize database tables on application startup.
initialize_database()


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=(
            os.getenv("FLASK_DEBUG", "false").lower()
            == "true"
        ),
    )