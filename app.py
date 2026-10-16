import csv
import io
import json
import logging
import math
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import requests
from flask import Flask, Response, jsonify, render_template, request

# ==================================================
# APPLICATION CONFIGURATION
# ==================================================

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO")
)
app.logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

DATABASE_PATH = os.environ.get(
    "DATABASE_PATH", "weather_history.db"
)
REQUEST_TIMEOUT = (5, 20)

GEOCODING_URL = (
    "https://geocoding-api.open-meteo.com/v1/search"
)
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = (
    "https://air-quality-api.open-meteo.com/v1/air-quality"
)

CACHE_TTLS = {
    "geocoding": 3600,
    "forecast": 900,
    "air_quality": 1800,
}

# Keep successful cached data for up to six hours
# if the weather provider is temporarily unavailable.
STALE_CACHE_MAX_AGE = 6 * 60 * 60

# Do not repeatedly contact a rate-limited endpoint.
DEFAULT_COOLDOWN = 60
MAX_COOLDOWN = 1800

MEMORY_CACHE = {}
CACHE_LOCK = Lock()

API_REQUEST_LOCKS = {}
API_REQUEST_LOCKS_LOCK = Lock()

API_COOLDOWNS = {}
API_COOLDOWNS_LOCK = Lock()

http = requests.Session()
http.headers.update({
    "User-Agent": "WeatherWorld/3.0",
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
    return datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    )


# ==================================================
# DATABASE
# ==================================================

def connect_db():
    if DATABASE_PATH != ":memory:":
        Path(DATABASE_PATH).expanduser().resolve().parent.mkdir(
            parents=True,
            exist_ok=True,
        )

    db = sqlite3.connect(
        DATABASE_PATH,
        timeout=20,
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=20000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize_database():
    with connect_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                country TEXT NOT NULL DEFAULT '',
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'auto',
                created_at TEXT NOT NULL,
                UNIQUE(latitude, longitude)
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
            CREATE TABLE IF NOT EXISTS api_cache (
                cache_key TEXT PRIMARY KEY,
                cache_type TEXT NOT NULL,
                saved_at REAL NOT NULL,
                payload TEXT NOT NULL
            )
        """)

        db.commit()


# ==================================================
# VALIDATION AND RESPONSES
# ==================================================

def clean_text(value, default="", max_length=150):
    if value is None:
        return default

    value = str(value).strip()
    return value[:max_length] if value else default


def parse_coordinate(value, field):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"Please provide a valid {field}."
        )

    if not math.isfinite(number):
        raise ValueError(
            f"{field.capitalize()} must be a finite number."
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


def error_response(message, status=400):
    return jsonify({"error": message}), status


def location_from_args():
    return {
        "name": clean_text(
            request.args.get("name"),
            "Selected location",
        ),
        "country": clean_text(
            request.args.get("country"), ""
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


def location_from_json(body):
    return {
        "name": clean_text(
            body.get("name"), "Saved location"
        ),
        "country": clean_text(
            body.get("country"), ""
        ),
        "latitude": parse_coordinate(
            body.get("latitude"), "latitude"
        ),
        "longitude": parse_coordinate(
            body.get("longitude"), "longitude"
        ),
        "timezone": clean_text(
            body.get("timezone"), "auto", 100
        ),
    }


# ==================================================
# CACHING
# ==================================================

def make_cache_key(url, params):
    normalized = sorted(
        (str(key), str(value))
        for key, value in (params or {}).items()
    )

    return url + "?" + json.dumps(
        normalized,
        separators=(",", ":"),
    )


def read_cache(key):
    with CACHE_LOCK:
        item = MEMORY_CACHE.get(key)

    if item is not None:
        return item

    try:
        with connect_db() as db:
            row = db.execute(
                """
                SELECT saved_at, payload
                FROM api_cache
                WHERE cache_key = ?
                """,
                (key,),
            ).fetchone()

        if row:
            item = {
                "saved_at": float(row["saved_at"]),
                "data": json.loads(row["payload"]),
            }

            with CACHE_LOCK:
                MEMORY_CACHE[key] = item

            return item

    except (sqlite3.Error, ValueError, TypeError):
        app.logger.warning(
            "Could not read API cache",
            exc_info=True,
        )

    return None


def write_cache(key, cache_type, data):
    item = {
        "saved_at": time.time(),
        "data": data,
    }

    with CACHE_LOCK:
        MEMORY_CACHE[key] = item

        if len(MEMORY_CACHE) > 300:
            oldest_key = min(
                MEMORY_CACHE,
                key=lambda cache_key: (
                    MEMORY_CACHE[cache_key]["saved_at"]
                ),
            )
            MEMORY_CACHE.pop(oldest_key, None)

    try:
        with connect_db() as db:
            db.execute(
                """
                INSERT INTO api_cache
                    (cache_key, cache_type, saved_at, payload)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    cache_type = excluded.cache_type,
                    saved_at = excluded.saved_at,
                    payload = excluded.payload
                """,
                (
                    key,
                    cache_type,
                    item["saved_at"],
                    json.dumps(data),
                ),
            )

            # Keep the newest 250 cached responses.
            db.execute("""
                DELETE FROM api_cache
                WHERE cache_key IN (
                    SELECT cache_key
                    FROM api_cache
                    ORDER BY saved_at DESC
                    LIMIT -1 OFFSET 250
                )
            """)

            db.commit()

    except sqlite3.Error:
        app.logger.warning(
            "Could not persist API cache",
            exc_info=True,
        )


def get_request_lock(key):
    with API_REQUEST_LOCKS_LOCK:
        lock = API_REQUEST_LOCKS.get(key)

        if lock is None:
            lock = Lock()
            API_REQUEST_LOCKS[key] = lock

        return lock


def get_cooldown(url):
    with API_COOLDOWNS_LOCK:
        return API_COOLDOWNS.get(url, 0)


def set_cooldown(url, seconds):
    with API_COOLDOWNS_LOCK:
        API_COOLDOWNS[url] = (
            time.time() + max(1, min(seconds, MAX_COOLDOWN))
        )


def parse_retry_after(response):
    value = response.headers.get("Retry-After")

    if value:
        try:
            return max(
                DEFAULT_COOLDOWN,
                min(int(value), MAX_COOLDOWN),
            )
        except (ValueError, TypeError):
            pass

    return DEFAULT_COOLDOWN


def api_get(url, params, cache_type="forecast"):
    """
    Get provider JSON with persistent caching.

    1. Use fresh cached data when possible.
    2. Serialize refreshes for identical requests.
    3. Never retry a 429 immediately.
    4. Respect the provider cooldown.
    5. Return stale successful data for up to six hours
       if the provider is unavailable.
    """
    params = params or {}
    key = make_cache_key(url, params)
    ttl = CACHE_TTLS.get(cache_type, 900)

    cached = read_cache(key)
    now = time.time()

    if cached and now - cached["saved_at"] < ttl:
        return cached["data"]

    with get_request_lock(key):
        # Another request may have refreshed the cache.
        cached = read_cache(key)
        now = time.time()

        if cached and now - cached["saved_at"] < ttl:
            return cached["data"]

        cooldown_until = get_cooldown(url)

        if now < cooldown_until:
            if (
                cached
                and now - cached["saved_at"]
                <= STALE_CACHE_MAX_AGE
            ):
                app.logger.warning(
                    "Provider cooldown active; "
                    "serving cached data."
                )
                return cached["data"]

            raise requests.HTTPError(
                "Provider is temporarily rate-limited."
            )

        try:
            response = http.get(
                url,
                params=params,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code == 429:
                set_cooldown(
                    url,
                    parse_retry_after(response),
                )

                app.logger.warning(
                    "Provider returned HTTP 429. "
                    "Cooldown enabled."
                )

                if (
                    cached
                    and time.time() - cached["saved_at"]
                    <= STALE_CACHE_MAX_AGE
                ):
                    return cached["data"]

                response.raise_for_status()

            response.raise_for_status()
            data = response.json()

            if not isinstance(data, dict) or data.get("error"):
                reason = (
                    data.get("reason", "Invalid provider response.")
                    if isinstance(data, dict)
                    else "Invalid provider response."
                )
                raise ValueError(
                    clean_text(
                        reason,
                        "Invalid provider response.",
                        250,
                    )
                )

            write_cache(key, cache_type, data)

            with API_COOLDOWNS_LOCK:
                API_COOLDOWNS.pop(url, None)

            return data

        except (requests.RequestException, ValueError):
            cached = read_cache(key)

            if (
                cached
                and time.time() - cached["saved_at"]
                <= STALE_CACHE_MAX_AGE
            ):
                app.logger.warning(
                    "Provider unavailable; using cached data.",
                    exc_info=True,
                )
                return cached["data"]

            raise


# ==================================================
# WEATHER DATA
# ==================================================

def weather_description(code):
    try:
        return WEATHER_CODES.get(
            int(code),
            ("Unknown conditions", "🌡️"),
        )
    except (TypeError, ValueError):
        return ("Unknown conditions", "🌡️")


def get_forecast(
    latitude,
    longitude,
    timezone_name="auto",
):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name or "auto",
        "forecast_days": 7,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
        "current": (
            "temperature_2m,relative_humidity_2m,"
            "apparent_temperature,is_day,precipitation,"
            "weather_code,cloud_cover,pressure_msl,"
            "wind_speed_10m,wind_direction_10m"
        ),
        "hourly": (
            "temperature_2m,precipitation_probability,"
            "weather_code,wind_speed_10m,uv_index"
        ),
        "daily": (
            "weather_code,temperature_2m_max,"
            "temperature_2m_min,sunrise,sunset,uv_index_max"
        ),
    }

    return api_get(
        FORECAST_URL,
        params,
        "forecast",
    )


def get_air_quality(
    latitude,
    longitude,
    timezone_name="auto",
):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name or "auto",
        "current": (
            "european_aqi,us_aqi,pm10,pm2_5,"
            "carbon_monoxide,nitrogen_dioxide,"
            "sulphur_dioxide,ozone"
        ),
    }

    data = api_get(
        AIR_QUALITY_URL,
        params,
        "air_quality",
    )

    return data.get("current")


# ==================================================
# SEARCH HISTORY
# ==================================================

def record_search(location):
    with connect_db() as db:
        db.execute(
            """
            INSERT INTO search_history
                (name, country, latitude, longitude,
                 timezone, searched_at)
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

        db.execute("""
            DELETE FROM search_history
            WHERE id NOT IN (
                SELECT id
                FROM search_history
                ORDER BY id DESC
                LIMIT 100
            )
        """)

        db.commit()


# ==================================================
# MAIN PAGE AND HEALTH CHECKS
# ==================================================

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    try:
        with connect_db() as db:
            db.execute("SELECT 1").fetchone()

        return jsonify({
            "status": "ok",
            "service": "WeatherWorld",
            "database": "ok",
            "timestamp": utc_now(),
        })

    except sqlite3.Error:
        app.logger.exception(
            "Database health check failed"
        )

        return jsonify({
            "status": "error",
            "service": "WeatherWorld",
            "database": "error",
            "timestamp": utc_now(),
        }), 503


@app.get("/api/provider-health")
def provider_health():
    try:
        api_get(
            GEOCODING_URL,
            {
                "name": "London",
                "count": 1,
                "language": "en",
                "format": "json",
            },
            "geocoding",
        )

        return jsonify({
            "status": "online",
            "provider": "Open-Meteo",
        })

    except (requests.RequestException, ValueError):
        app.logger.warning(
            "Provider health check failed",
            exc_info=True,
        )

        return jsonify({
            "status": "offline",
            "provider": "Open-Meteo",
            "message": "Weather provider unavailable.",
        }), 503


# ==================================================
# LOCATION SEARCH
# ==================================================

@app.get("/api/search")
def search_locations():
    query = clean_text(
        request.args.get("q"),
        "",
        100,
    )

    if len(query) < 2:
        return jsonify({"results": []})

    try:
        data = api_get(
            GEOCODING_URL,
            {
                "name": query,
                "count": 8,
                "language": "en",
                "format": "json",
            },
            "geocoding",
        )

        results = []

        for item in data.get("results", []):
            if (
                item.get("latitude") is None
                or item.get("longitude") is None
            ):
                continue

            results.append({
                "name": item.get("name", "Unknown"),
                "country": item.get("country", ""),
                "country_code": item.get("country_code", ""),
                "admin1": item.get("admin1", ""),
                "latitude": item["latitude"],
                "longitude": item["longitude"],
                "timezone": item.get("timezone", "auto"),
            })

        return jsonify({"results": results})

   
    except requests.Timeout:
        return error_response(
            "Location search timed out. Please try again.",
            504,
        )

    except requests.RequestException as exc:
        app.logger.exception("Location search failed: %s", exc)
        return error_response(
            "Location search failed. Please try again later.",
            502,
        )

    except ValueError:
        app.logger.exception("Invalid city search response")
        return error_response(
            "The location service returned invalid data.",
            502,
        )


# ==================================================
# CURRENT WEATHER AND FORECAST
# ==================================================

@app.get("/api/weather")
def weather():
    try:
        location = location_from_args()

    except ValueError as exc:
        return error_response(str(exc), 400)

    try:
        data = get_forecast(
            location["latitude"],
            location["longitude"],
            location["timezone"],
        )

    except requests.Timeout:
        return error_response(
            "Weather service timed out. Please retry.",
            504,
        )

    except requests.RequestException as exc:
        app.logger.warning(
            "Weather provider request failed: %s", exc
        )

        if (
            isinstance(exc, requests.HTTPError)
            and getattr(exc.response, "status_code", None) == 429
        ):
            return error_response(
                "Open-Meteo is rate-limiting requests. "
                "Please wait and try again.",
                503,
            )

        return error_response(
            "Could not retrieve weather data. "
            "Please try again later.",
            502,
        )

    except ValueError:
        app.logger.exception(
            "Invalid weather response"
        )
        return error_response(
            "The weather service returned invalid data.",
            502,
        )

    current = dict(data.get("current") or {})

    description, icon = weather_description(
        current.get("weather_code")
    )

    current["description"] = description
    current["icon"] = icon

    air_quality = None
    air_quality_error = None

    try:
        air_quality = get_air_quality(
            location["latitude"],
            location["longitude"],
            location["timezone"],
        )

    except (requests.RequestException, ValueError):
        air_quality_error = (
            "Air-quality information is temporarily unavailable."
        )
        app.logger.warning(
            "Air-quality request failed",
            exc_info=True,
        )

    try:
        record_search(location)

    except sqlite3.Error:
        app.logger.exception(
            "Could not save search history"
        )

    return jsonify({
        "location": location,
        "current": current,
        "hourly": data.get("hourly") or {},
        "daily": data.get("daily") or {},
        "air_quality": air_quality,
        "air_quality_error": air_quality_error,
        "source": "Open-Meteo",
        "updated_at": utc_now(),
    })


# ==================================================
# HISTORY ENDPOINTS
# ==================================================

@app.get("/api/history")
def get_history():
    try:
        with connect_db() as db:
            rows = db.execute("""
                SELECT id, name, country, latitude, longitude,
                       timezone, searched_at
                FROM search_history
                ORDER BY id DESC
                LIMIT 10
            """).fetchall()

        return jsonify({
            "results": [dict(row) for row in rows]
        })

    except sqlite3.Error:
        app.logger.exception(
            "Could not retrieve history"
        )
        return error_response(
            "Could not retrieve search history.", 500
        )


@app.delete("/api/history")
def clear_history():
    try:
        with connect_db() as db:
            db.execute("DELETE FROM search_history")
            db.commit()

        return jsonify({
            "message": "Search history cleared."
        })

    except sqlite3.Error:
        app.logger.exception(
            "Could not clear history"
        )
        return error_response(
            "Could not clear search history.", 500
        )


# ==================================================
# FAVORITES ENDPOINTS
# ==================================================

@app.get("/api/favorites")
def get_favorites():
    try:
        with connect_db() as db:
            rows = db.execute("""
                SELECT id, name, country, latitude, longitude,
                       timezone, created_at
                FROM favorites
                ORDER BY name COLLATE NOCASE ASC
            """).fetchall()

        return jsonify({
            "results": [dict(row) for row in rows]
        })

    except sqlite3.Error:
        app.logger.exception(
            "Could not retrieve favorites"
        )
        return error_response(
            "Could not retrieve favorites.", 500
        )


@app.post("/api/favorites")
def add_favorite():
    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return error_response(
            "A JSON location object is required.", 400
        )

    try:
        location = location_from_json(body)

    except ValueError as exc:
        return error_response(str(exc), 400)

    try:
        with connect_db() as db:
            existing = db.execute(
                """
                SELECT id FROM favorites
                WHERE latitude = ? AND longitude = ?
                """,
                (
                    location["latitude"],
                    location["longitude"],
                ),
            ).fetchone()

            if existing:
                return jsonify({
                    "message": "This location is already a favorite.",
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

            db.commit()

        return jsonify({
            "message": "Location saved to favorites.",
            "id": cursor.lastrowid,
            "location": location,
        }), 201

    except sqlite3.IntegrityError:
        return error_response(
            "This location is already saved.", 409
        )

    except sqlite3.Error:
        app.logger.exception(
            "Could not save favorite"
        )
        return error_response(
            "Could not save favorite.", 500
        )


@app.delete("/api/favorites/<int:favorite_id>")
def delete_favorite(favorite_id):
    try:
        with connect_db() as db:
            cursor = db.execute(
                "DELETE FROM favorites WHERE id = ?",
                (favorite_id,),
            )
            db.commit()

        if cursor.rowcount == 0:
            return error_response(
                "Favorite not found.", 404
            )

        return jsonify({
            "message": "Favorite removed."
        })

    except sqlite3.Error:
        app.logger.exception(
            "Could not delete favorite"
        )
        return error_response(
            "Could not remove favorite.", 500
        )


# ==================================================
# CSV EXPORT
# ==================================================

@app.get("/api/export")
def export_history():
    try:
        with connect_db() as db:
            rows = db.execute("""
                SELECT name, country, latitude, longitude,
                       timezone, searched_at
                FROM search_history
                ORDER BY id DESC
            """).fetchall()

        output = io.StringIO(newline="")
        writer = csv.writer(output)

        writer.writerow([
            "Location",
            "Country",
            "Latitude",
            "Longitude",
            "Timezone",
            "Searched At",
        ])

        for row in rows:
            writer.writerow([
                row["name"],
                row["country"],
                row["latitude"],
                row["longitude"],
                row["timezone"],
                row["searched_at"],
            ])

        return Response(
            "\ufeff" + output.getvalue(),
            mimetype="text/csv; charset=utf-8",
            headers={
                "Content-Disposition":
                    "attachment; filename=weather_history.csv",
                "Cache-Control": "no-store",
            },
        )

    except sqlite3.Error:
        app.logger.exception(
            "Could not export history"
        )
        return error_response(
            "Could not export search history.", 500
        )


# ==================================================
# ERROR HANDLERS
# ==================================================

@app.errorhandler(404)
def not_found(error):
    if request.path.startswith("/api/"):
        return error_response(
            "API endpoint not found.", 404
        )

    return "Page not found.", 404


@app.errorhandler(405)
def method_not_allowed(error):
    return error_response(
        "HTTP method not allowed.", 405
    )


@app.errorhandler(413)
def request_too_large(error):
    return error_response(
        "Request payload is too large.", 413
    )


@app.errorhandler(500)
def internal_server_error(error):
    app.logger.error(
        "Unhandled application error: %s", error
    )
    return error_response(
        "An internal server error occurred.", 500
    )


# ==================================================
# START APPLICATION
# ==================================================

initialize_database()
app.logger.info(
    "WeatherWorld database initialized."
)


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )