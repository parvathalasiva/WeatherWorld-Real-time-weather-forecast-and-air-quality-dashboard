
import csv
import io
import logging
import math
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request

# ============================================================
# WEATHERWORLD CONFIGURATION
# ============================================================

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

logging.basicConfig(level=logging.INFO)
app.logger.setLevel(logging.INFO)

DATABASE_PATH = os.environ.get("DATABASE_PATH", "weather_history.db")
REQUEST_TIMEOUT = 15

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# In-memory API cache. Successful responses are reused to reduce API calls.
API_CACHE = {}
CACHE_MAX_ENTRIES = 200
CACHE_TTLS = {
    GEOCODING_URL: 3600,    # 1 hour
    FORECAST_URL: 600,      # 10 minutes
    AIR_QUALITY_URL: 1800,  # 30 minutes
}
STALE_CACHE_MAX_AGE = 21600  # Allow cached data up to 6 hours old on provider failure.

DEFAULT_LOCATION = {
    "name": "Kadapa",
    "country": "India",
    "latitude": 14.46795,
    "longitude": 78.82346,
    "timezone": "Asia/Kolkata",
}

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


# ============================================================
# DATABASE
# ============================================================

def connect_db():
    """Create a SQLite connection with sensible defaults."""
    if DATABASE_PATH != ":memory:":
        Path(DATABASE_PATH).expanduser().resolve().parent.mkdir(
            parents=True, exist_ok=True
        )

    db = sqlite3.connect(DATABASE_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 15000")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def initialize_database():
    """Create database tables and indexes."""
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
        db.commit()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ============================================================
# VALIDATION AND HELPERS
# ============================================================

def clean_text(value, default="", max_length=150):
    if value is None:
        return default
    result = str(value).strip()
    return result[:max_length] if result else default


def parse_coordinate(value, field_name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Please provide a valid {field_name}.")

    if not math.isfinite(number):
        raise ValueError(f"{field_name.capitalize()} must be finite.")

    if field_name == "latitude" and not -90 <= number <= 90:
        raise ValueError("Latitude must be between -90 and 90.")

    if field_name == "longitude" and not -180 <= number <= 180:
        raise ValueError("Longitude must be between -180 and 180.")

    return number


def error_response(message, status_code=400):
    return jsonify({"error": message}), status_code


# ============================================================
# API REQUESTS WITH CACHING AND RATE-LIMIT HANDLING
# ============================================================

def api_get(url, params):
    """
    Fetch JSON from an API, cache successful results, and use cached
    results when the provider is temporarily unavailable.

    This avoids unnecessary repeat calls but cannot bypass a provider's
    rate limits when no suitable cached response exists.
    """
    cache_key = (
        url,
        tuple(sorted((str(k), str(v)) for k, v in params.items()))
    )
    now = time.time()
    ttl = CACHE_TTLS.get(url, 300)
    cached = API_CACHE.get(cache_key)

    # Return a fresh cached response without making another API request.
    if cached and now - cached["saved_at"] < ttl:
        return cached["data"]

    try:
        response = requests.get(
            url,
            params=params,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "WeatherWorld/2.0"},
        )

        # Do not repeatedly retry a 429 response.
        if response.status_code == 429:
            if cached and now - cached["saved_at"] < STALE_CACHE_MAX_AGE:
                app.logger.warning(
                    "API rate limited; returning cached data for %s", url
                )
                return cached["data"]

            response.raise_for_status()

        response.raise_for_status()
        data = response.json()

        if not isinstance(data, dict):
            raise ValueError("Unexpected response from the weather provider.")

        if data.get("error"):
            raise ValueError(
                clean_text(
                    data.get("reason"),
                    "Weather provider returned an error."
                )
            )

        # Save successful responses.
        API_CACHE[cache_key] = {
            "saved_at": now,
            "data": data,
        }

        # Keep the in-memory cache bounded.
        if len(API_CACHE) > CACHE_MAX_ENTRIES:
            oldest_key = min(
                API_CACHE,
                key=lambda key: API_CACHE[key]["saved_at"]
            )
            API_CACHE.pop(oldest_key, None)

        return data

    except requests.RequestException:
        # If the provider fails, use recent cached data if available.
        if cached and now - cached["saved_at"] < STALE_CACHE_MAX_AGE:
            app.logger.warning(
                "API request failed; returning cached data for %s", url
            )
            return cached["data"]

        app.logger.exception("API request failed for %s", url)
        raise


def location_from_args():
    return {
        "name": clean_text(request.args.get("name"), "Selected location"),
        "country": clean_text(request.args.get("country"), ""),
        "latitude": parse_coordinate(
            request.args.get("latitude"), "latitude"
        ),
        "longitude": parse_coordinate(
            request.args.get("longitude"), "longitude"
        ),
        "timezone": clean_text(request.args.get("timezone"), "auto", 100),
    }


def location_from_json(body):
    return {
        "name": clean_text(body.get("name"), "Saved location"),
        "country": clean_text(body.get("country"), ""),
        "latitude": parse_coordinate(body.get("latitude"), "latitude"),
        "longitude": parse_coordinate(body.get("longitude"), "longitude"),
        "timezone": clean_text(body.get("timezone"), "auto", 100),
    }


def record_search(location):
    with connect_db() as db:
        db.execute("""
            INSERT INTO search_history
                (name, country, latitude, longitude, timezone, searched_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            location["name"],
            location["country"],
            location["latitude"],
            location["longitude"],
            location["timezone"],
            utc_now(),
        ))

        # Retain only the most recent 100 searches.
        db.execute("""
            DELETE FROM search_history
            WHERE id NOT IN (
                SELECT id FROM search_history
                ORDER BY id DESC LIMIT 100
            )
        """)
        db.commit()


def weather_description(code):
    try:
        return WEATHER_CODES.get(
            int(code), ("Unknown conditions", "🌡️")
        )
    except (TypeError, ValueError):
        return ("Unknown conditions", "🌡️")


# ============================================================
# OPEN-METEO FORECAST
# ============================================================

def get_forecast(latitude, longitude, timezone_name="auto"):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name,
        "forecast_days": 7,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
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
            "uv_index",
        ]),
        "hourly": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "precipitation_probability",
            "precipitation",
            "weather_code",
            "wind_speed_10m",
            "uv_index",
        ]),
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "sunrise",
            "sunset",
            "uv_index_max",
            "precipitation_sum",
            "precipitation_probability_max",
            "wind_speed_10m_max",
        ]),
    }
    return api_get(FORECAST_URL, params)


def get_air_quality(latitude, longitude, timezone_name="auto"):
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name,
        "current": ",".join([
            "european_aqi",
            "us_aqi",
            "pm10",
            "pm2_5",
            "carbon_monoxide",
            "nitrogen_dioxide",
            "sulphur_dioxide",
            "ozone",
        ]),
    }
    data = api_get(AIR_QUALITY_URL, params)
    return data.get("current")


# ============================================================
# MAIN PAGE
# ============================================================

@app.get("/")
def index():
    return render_template("index.html")


# ============================================================
# HEALTH CHECKS
# ============================================================

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
        app.logger.exception("Database health check failed")
        return error_response("Database is unavailable.", 500)


@app.get("/api/provider-health")
def provider_health():
    try:
        api_get(GEOCODING_URL, {
            "name": "London",
            "count": 1,
            "language": "en",
            "format": "json",
        })
        return jsonify({
            "status": "online",
            "provider": "Open-Meteo",
        })
    except (requests.RequestException, ValueError):
        app.logger.warning("Open-Meteo health check failed", exc_info=True)
        return jsonify({
            "status": "offline",
            "provider": "Open-Meteo",
            "message": "The weather provider could not be reached.",
        }), 503


# ============================================================
# CITY SEARCH
# ============================================================

@app.get("/api/search")
def search_locations():
    query = clean_text(request.args.get("q"), "", 100)

    if len(query) < 2:
        return jsonify({"results": []})

    try:
        data = api_get(GEOCODING_URL, {
            "name": query,
            "count": 8,
            "language": "en",
            "format": "json",
        })

        results = []
        for item in data.get("results", []):
            latitude = item.get("latitude")
            longitude = item.get("longitude")

            if latitude is None or longitude is None:
                continue

            results.append({
                "name": item.get("name", "Unknown"),
                "country": item.get("country", ""),
                "country_code": item.get("country_code", ""),
                "admin1": item.get("admin1", ""),
                "latitude": latitude,
                "longitude": longitude,
                "timezone": item.get("timezone", "auto"),
            })

        return jsonify({"results": results})

    except requests.Timeout:
        return error_response(
            "Location search timed out. Please try again.", 504
        )
    except requests.RequestException:
        app.logger.exception("City search request failed")
        return error_response(
            "Location search is temporarily unavailable.", 502
        )
    except ValueError:
        app.logger.exception("Invalid city search response")
        return error_response(
            "The location service returned invalid data.", 502
        )


# ============================================================
# CURRENT WEATHER, FORECASTS AND AIR QUALITY
# ============================================================

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
            "The weather service timed out. Please retry.", 504
        )
    except requests.RequestException:
        app.logger.exception("Weather provider request failed")
        return error_response(
            "Could not retrieve weather data. Please try again shortly.",
            502,
        )
    except ValueError:
        app.logger.exception("Invalid weather response")
        return error_response(
            "The weather service returned invalid data.", 502
        )

    current = data.get("current") or {}
    hourly = data.get("hourly") or {}
    daily = data.get("daily") or {}

    description, icon = weather_description(current.get("weather_code"))
    current["description"] = description
    current["icon"] = icon

    # Fallback when current UV is not included in the response.
    if current.get("uv_index") is None:
        times = hourly.get("time") or []
        uv_values = hourly.get("uv_index") or []
        current_time = current.get("time")

        if times and len(times) == len(uv_values):
            try:
                if current_time:
                    target = datetime.fromisoformat(
                        current_time.replace("Z", "+00:00")
                    )
                    if target.tzinfo is None:
                        target = target.replace(tzinfo=timezone.utc)

                    def time_distance(index):
                        value = datetime.fromisoformat(
                            times[index].replace("Z", "+00:00")
                        )
                        if value.tzinfo is None:
                            value = value.replace(tzinfo=target.tzinfo)
                        return abs((value - target).total_seconds())

                    closest = min(range(len(times)), key=time_distance)
                else:
                    closest = 0

                current["uv_index"] = uv_values[closest]
            except (ValueError, TypeError, IndexError):
                current["uv_index"] = None

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
        app.logger.warning("Air-quality request failed", exc_info=True)

    try:
        record_search(location)
    except sqlite3.Error:
        app.logger.exception("Could not save search history")

    return jsonify({
        "location": location,
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "air_quality": air_quality,
        "air_quality_error": air_quality_error,
        "source": "Open-Meteo",
        "updated_at": utc_now(),
    })


# ============================================================
# SEARCH HISTORY
# ============================================================

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

        return jsonify({"results": [dict(row) for row in rows]})
    except sqlite3.Error:
        app.logger.exception("Could not retrieve search history")
        return error_response("Could not retrieve search history.", 500)


@app.delete("/api/history")
def clear_history():
    try:
        with connect_db() as db:
            db.execute("DELETE FROM search_history")
            db.commit()

        return jsonify({"message": "Search history cleared."})
    except sqlite3.Error:
        app.logger.exception("Could not clear search history")
        return error_response("Could not clear search history.", 500)


# ============================================================
# FAVORITES
# ============================================================

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

        return jsonify({"results": [dict(row) for row in rows]})
    except sqlite3.Error:
        app.logger.exception("Could not retrieve favorites")
        return error_response("Could not retrieve favorite locations.", 500)


@app.post("/api/favorites")
def add_favorite():
    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return error_response("A JSON location object is required.", 400)

    try:
        location = location_from_json(body)
    except ValueError as exc:
        return error_response(str(exc), 400)

    try:
        with connect_db() as db:
            existing = db.execute("""
                SELECT id FROM favorites
                WHERE latitude = ? AND longitude = ?
            """, (
                location["latitude"],
                location["longitude"],
            )).fetchone()

            if existing:
                return jsonify({
                    "message": "This location is already a favorite.",
                    "id": existing["id"],
                })

            cursor = db.execute("""
                INSERT INTO favorites
                    (name, country, latitude, longitude, timezone, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                location["name"],
                location["country"],
                location["latitude"],
                location["longitude"],
                location["timezone"],
                utc_now(),
            ))
            db.commit()

        return jsonify({
            "message": "Location saved to favorites.",
            "id": cursor.lastrowid,
            "location": location,
        }), 201

    except sqlite3.IntegrityError:
        return error_response("This location is already saved.", 409)
    except sqlite3.Error:
        app.logger.exception("Could not save favorite")
        return error_response("Could not save this favorite.", 500)


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
            return error_response("Favorite location not found.", 404)

        return jsonify({"message": "Favorite removed."})

    except sqlite3.Error:
        app.logger.exception("Could not delete favorite")
        return error_response("Could not remove favorite.", 500)


# ============================================================
# CSV EXPORT
# ============================================================

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
        app.logger.exception("Could not export search history")
        return error_response("Could not export search history.", 500)


# ============================================================
# ERROR HANDLERS
# ============================================================

@app.errorhandler(404)
def not_found(error):
    if request.path.startswith("/api/"):
        return error_response("API endpoint not found.", 404)
    return "Page not found.", 404


@app.errorhandler(405)
def method_not_allowed(error):
    return error_response("HTTP method not allowed.", 405)


@app.errorhandler(413)
def request_too_large(error):
    return error_response("Request payload is too large.", 413)


@app.errorhandler(500)
def internal_server_error(error):
    app.logger.error("Unhandled application error: %s", error)
    return error_response("An internal server error occurred.", 500)


# ============================================================
# INITIALIZATION
# ============================================================

initialize_database()
app.logger.info("WeatherWorld database initialized.")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
