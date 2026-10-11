
"use strict";

const API = {
    health: "/api/health",
    search: "/api/search",
    weather: "/api/weather",
    history: "/api/history",
    export: "/api/export",
    favorites: "/api/favorites"
};

const $ = (selector) => document.querySelector(selector);

const state = {
    location: null,
    weather: null,
    unit: "celsius",
    dark: false,
    favorites: [],
    history: [],
    suggestions: [],
    map: null,
    marker: null,
    mapReady: false,
    searchTimer: null,
    toastTimer: null,
    requestId: 0
};

const el = {
    searchForm: $("#searchForm"),
    locationInput: $("#locationInput"),
    searchButton: $("#searchButton"),
    suggestions: $("#suggestions"),
    currentLocationButton: $("#currentLocationButton"),
    coordinateToggle: $("#coordinateToggle"),
    coordinateForm: $("#coordinateForm"),
    latitudeInput: $("#latitudeInput"),
    longitudeInput: $("#longitudeInput"),
    unitToggle: $("#unitToggle"),
    themeToggle: $("#themeToggle"),
    statusMessage: $("#statusMessage"),
    currentWeather: $("#currentWeather"),
    hourlyForecast: $("#hourlyForecast"),
    dailyForecast: $("#dailyForecast"),
    favoriteButton: $("#favoriteButton"),
    favoritesList: $("#favoritesList"),
    historyList: $("#historyList"),
    refreshHistoryButton: $("#refreshHistoryButton"),
    exportButton: $("#exportButton"),
    loadingOverlay: $("#loadingOverlay"),
    toast: $("#toast"),
    apiStatusDot: $("#apiStatusDot"),
    apiStatusText: $("#apiStatusText"),
    coordinatesDisplay: $("#coordinatesDisplay"),
    airQualityStatus: $("#airQualityStatus"),
    airSummary: $("#airSummary"),
    airDetail: $("#airDetail")
};

/* -------------------- Helpers -------------------- */

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function valueFrom(object, ...keys) {
    for (const key of keys) {
        if (object && object[key] !== undefined && object[key] !== null) {
            return object[key];
        }
    }
    return null;
}

function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
}

function fmt(value, digits = 0) {
    const number = asNumber(value);
    return number === null ? "—" : number.toFixed(digits);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function responseItems(data, ...keys) {
    if (Array.isArray(data)) return data;
    for (const key of keys) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    return [];
}

function normalizeLocation(item = {}) {
    return {
        id: item.id ?? null,
        name: String(valueFrom(item, "name", "city", "display_name") || "Unknown location"),
        country: String(valueFrom(item, "country", "country_name") || ""),
        country_code: String(valueFrom(item, "country_code", "countryCode") || ""),
        admin1: String(valueFrom(item, "admin1", "state", "region") || ""),
        admin2: String(valueFrom(item, "admin2", "district", "county") || ""),
        latitude: asNumber(valueFrom(item, "latitude", "lat")),
        longitude: asNumber(valueFrom(item, "longitude", "lon", "lng")),
        timezone: String(item.timezone || ""),
        source: item.source || ""
    };
}

function locationLabel(location) {
    if (!location) return "Unknown location";
    return [...new Set([
        location.name,
        location.admin1,
        location.country
    ].filter(Boolean))].join(", ");
}

function showToast(message, type = "info") {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.className = `toast toast-${type}`;
    el.toast.classList.remove("hidden");

    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

function showStatus(message, type = "info") {
    if (!el.statusMessage) return;
    el.statusMessage.textContent = message;
    el.statusMessage.className = `status-message status-${type}`;
    el.statusMessage.classList.remove("hidden");
}

function clearStatus() {
    el.statusMessage?.classList.add("hidden");
}

function setLoading(loading) {
    el.loadingOverlay?.classList.toggle("hidden", !loading);

    if (el.searchButton) {
        el.searchButton.disabled = loading;
        el.searchButton.innerHTML = loading ? "Loading…" : 'Search <span>→</span>';
    }
}

async function apiRequest(url, options = {}) {
    const config = {
        method: options.method || "GET",
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        },
        ...(options.body ? { body: options.body } : {})
    };

    const response = await fetch(url, config);
    const contentType = response.headers.get("content-type") || "";

    let data;
    if (contentType.includes("application/json")) {
        data = await response.json();
    } else {
        data = await response.text();
    }

    if (!response.ok) {
        const message = typeof data === "object"
            ? data.error || data.message || `Request failed (${response.status})`
            : data || `Request failed (${response.status})`;
        throw new Error(message);
    }

    return data;
}

function isFahrenheit() {
    return state.unit === "fahrenheit";
}

function temperature(value) {
    let number = asNumber(value);
    if (number === null) return "—";
    if (isFahrenheit()) number = number * 9 / 5 + 32;
    return `${Math.round(number)}°${isFahrenheit() ? "F" : "C"}`;
}

function windSpeed(value) {
    const number = asNumber(value);
    return number === null ? "—" : `${Math.round(number)} km/h`;
}

function timeLabel(value, options = {}) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        ...options
    }).format(date);
}

function dayLabel(value) {
    if (!value) return "—";
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric"
    }).format(date);
}

function weatherInfo(code) {
    const map = {
        0: ["Clear sky", "☀️"],
        1: ["Mainly clear", "🌤️"],
        2: ["Partly cloudy", "⛅"],
        3: ["Overcast", "☁️"],
        45: ["Fog", "🌫️"],
        48: ["Rime fog", "🌫️"],
        51: ["Light drizzle", "🌦️"],
        53: ["Drizzle", "🌦️"],
        55: ["Heavy drizzle", "🌧️"],
        56: ["Freezing drizzle", "🌧️"],
        57: ["Heavy freezing drizzle", "🌧️"],
        61: ["Light rain", "🌦️"],
        63: ["Moderate rain", "🌧️"],
        65: ["Heavy rain", "🌧️"],
        66: ["Freezing rain", "🌧️"],
        67: ["Heavy freezing rain", "🌧️"],
        71: ["Light snow", "🌨️"],
        73: ["Snow", "❄️"],
        75: ["Heavy snow", "❄️"],
        77: ["Snow grains", "🌨️"],
        80: ["Rain showers", "🌦️"],
        81: ["Moderate showers", "🌧️"],
        82: ["Heavy showers", "⛈️"],
        85: ["Snow showers", "🌨️"],
        86: ["Heavy snow showers", "❄️"],
        95: ["Thunderstorm", "⛈️"],
        96: ["Thunderstorm with hail", "⛈️"],
        99: ["Severe thunderstorm", "⛈️"]
    };

    return map[asNumber(code)] || ["Weather unavailable", "🌡️"];
}

/* -------------------- Search -------------------- */

function parseCountrySuffix(query) {
    const parts = query.split(",").map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return { query, country: "" };

    return {
        query,
        country: parts[parts.length - 1]
    };
}

async function searchLocations(query) {
    const parsed = parseCountrySuffix(query);
    const url = new URL(API.search, window.location.origin);
    url.searchParams.set("q", query);

    // The backend parses country names in q itself. Supplying this parameter
    // also supports an explicit country filter when one was typed.
    if (parsed.country) url.searchParams.set("country", parsed.country);

    const data = await apiRequest(url.toString());
    return responseItems(data, "results", "locations", "items")
        .map(normalizeLocation)
        .filter(item => item.latitude !== null && item.longitude !== null);
}

function renderSuggestions(locations) {
    state.suggestions = locations;

    if (!el.suggestions) return;

    if (!locations.length) {
        el.suggestions.innerHTML = `
            <div class="suggestion-empty">
                <strong>No matching locations found</strong>
                <span>Try adding a country, state, or district.</span>
            </div>`;
        el.suggestions.classList.remove("hidden");
        return;
    }

    el.suggestions.innerHTML = locations.slice(0, 8).map((location, index) => `
        <button type="button" class="suggestion-item" data-suggestion-index="${index}" role="option">
            <span class="suggestion-pin">⌖</span>
            <span class="suggestion-text">
                <strong>${escapeHTML(location.name)}</strong>
                <small>${escapeHTML([location.admin1, location.admin2, location.country].filter(Boolean).join(", "))}</small>
            </span>
            <span class="suggestion-arrow">↗</span>
        </button>
    `).join("");

    el.suggestions.classList.remove("hidden");
}

function hideSuggestions() {
    el.suggestions?.classList.add("hidden");
}

async function autocomplete() {
    clearTimeout(state.searchTimer);

    const query = el.locationInput?.value.trim() || "";
    if (query.length < 2) {
        hideSuggestions();
        return;
    }

    state.searchTimer = setTimeout(async () => {
        try {
            const results = await searchLocations(query);
            renderSuggestions(results);
        } catch (error) {
            renderSuggestions([]);
        }
    }, 450);
}

async function searchByText(query) {
    query = String(query || "").trim();
    if (!query) {
        showToast("Enter a city, town, village, or country.", "error");
        return;
    }

    setLoading(true);
    clearStatus();
    hideSuggestions();

    try {
        let results = await searchLocations(query);

        // If a country-qualified search fails, try the place name separately.
        // The backend still applies its own country filtering when available.
        if (!results.length && query.includes(",")) {
            const shorterQuery = query.split(",").slice(0, -1).join(",").trim();
            if (shorterQuery) results = await searchLocations(shorterQuery);
        }

        if (!results.length) {
            throw new Error(
                `No locations found for "${query}". Try adding the state, district, or a nearby larger town.`
            );
        }

        await loadWeather(results[0]);
    } catch (error) {
        showStatus(error.message || "Location search failed.", "error");
    } finally {
        setLoading(false);
    }
}

async function searchByCoordinates(latitude, longitude) {
    const lat = asNumber(latitude);
    const lon = asNumber(longitude);

    if (lat === null || lat < -90 || lat > 90) {
        showToast("Latitude must be between -90 and 90.", "error");
        return;
    }

    if (lon === null || lon < -180 || lon > 180) {
        showToast("Longitude must be between -180 and 180.", "error");
        return;
    }

    try {
        await loadWeather({
            name: "Selected coordinates",
            country: "",
            latitude: lat,
            longitude: lon
        });
    } catch (error) {
        showToast(error.message || "Could not load weather for these coordinates.", "error");
    }
}

/* -------------------- Weather API -------------------- */

async function loadWeather(locationInput) {
    const location = normalizeLocation(locationInput);

    if (location.latitude === null || location.longitude === null) {
        throw new Error("The selected location does not contain valid coordinates.");
    }

    const id = ++state.requestId;
    setLoading(true);
    clearStatus();
    hideSuggestions();

    try {
        const url = new URL(API.weather, window.location.origin);
        url.searchParams.set("latitude", location.latitude);
        url.searchParams.set("longitude", location.longitude);
        url.searchParams.set("name", location.name);

        if (location.country) url.searchParams.set("country", location.country);
        if (location.country_code) {
            url.searchParams.set("country_code", location.country_code);
        }

        const result = await apiRequest(url.toString());

        if (id !== state.requestId) return;

        state.location = normalizeLocation({
            ...location,
            ...(result.location || {})
        });
        state.weather = result;

        if (el.locationInput) {
            el.locationInput.value = locationLabel(state.location);
        }

        renderCurrentWeather(result);
        renderHourlyForecast(result);
        renderDailyForecast(result);
        renderAirQuality(result.air_quality);
        updateMap(state.location);
        updateFavoriteButton();

        showStatus(`Weather updated for ${locationLabel(state.location)}.`, "success");

        await Promise.all([loadHistory(), loadFavorites()]);
    } catch (error) {
        if (id === state.requestId) {
            showStatus(error.message || "Unable to load weather.", "error");
        }
        throw error;
    } finally {
        if (id === state.requestId) setLoading(false);
    }
}

/* -------------------- Current weather -------------------- */

function renderCurrentWeather(result) {
    const location = state.location;
    const current = result.current || {};
    const [description, icon] = weatherInfo(
        valueFrom(current, "weather_code", "weathercode")
    );

    const humidity = valueFrom(current, "relative_humidity_2m", "humidity");
    const wind = valueFrom(current, "wind_speed_10m", "wind_speed");
    const windDirection = valueFrom(current, "wind_direction_10m", "wind_direction");
    const pressure = valueFrom(current, "surface_pressure", "pressure_msl");
    const cloudCover = valueFrom(current, "cloud_cover", "cloudcover");
    const feelsLike = valueFrom(current, "apparent_temperature", "feels_like");
    const updateTime = valueFrom(current, "time") || result.updated_at;

    el.currentWeather.innerHTML = `
        <div class="current-main">
            <div class="current-place">
                <span class="place-pin">⌖</span>
                <div>
                    <h3>${escapeHTML(locationLabel(location))}</h3>
                    <p>${updateTime ? `Updated ${escapeHTML(timeLabel(updateTime))}` : "Current conditions"}</p>
                </div>
            </div>
            <div class="current-condition">
                <span class="weather-emoji" aria-hidden="true">${icon}</span>
                <div>
                    <div class="current-temperature">${temperature(current.temperature_2m)}</div>
                    <p>${escapeHTML(description)}</p>
                    <small>Feels like ${temperature(feelsLike)}</small>
                </div>
            </div>
        </div>

        <div class="weather-metrics">
            <div class="metric-card"><span class="metric-icon">💧</span><span class="metric-label">Humidity</span><strong>${humidity == null ? "—" : `${fmt(humidity)}%`}</strong></div>
            <div class="metric-card"><span class="metric-icon">💨</span><span class="metric-label">Wind speed</span><strong>${windSpeed(wind)}</strong></div>
            <div class="metric-card"><span class="metric-icon">🧭</span><span class="metric-label">Wind direction</span><strong>${windDirection == null ? "—" : `${fmt(windDirection)}°`}</strong></div>
            <div class="metric-card"><span class="metric-icon">◉</span><span class="metric-label">Pressure</span><strong>${pressure == null ? "—" : `${fmt(pressure)} hPa`}</strong></div>
            <div class="metric-card"><span class="metric-icon">☁</span><span class="metric-label">Cloud cover</span><strong>${cloudCover == null ? "—" : `${fmt(cloudCover)}%`}</strong></div>
            <div class="metric-card"><span class="metric-icon">🌐</span><span class="metric-label">Coordinates</span><strong class="coordinate-metric">${location.latitude.toFixed(3)}, ${location.longitude.toFixed(3)}</strong></div>
        </div>
    `;
}

/* -------------------- Hourly forecast -------------------- */

function renderHourlyForecast(result) {
    const hourly = result.hourly || {};
    const times = asArray(hourly.time);
    const temperatures = asArray(hourly.temperature_2m);
    const codes = asArray(hourly.weather_code || hourly.weathercode);
    const rain = asArray(hourly.precipitation_probability);

    if (!times.length) {
        el.hourlyForecast.innerHTML = '<p class="muted">Hourly forecast is unavailable.</p>';
        return;
    }

    const now = Date.now();
    let indices = times.map((time, index) => ({
        time,
        index,
        stamp: new Date(time).getTime()
    })).filter(item => Number.isFinite(item.stamp) && item.stamp >= now - 3600000).slice(0, 24);

    if (!indices.length) {
        indices = times.slice(0, 24).map((time, index) => ({ time, index }));
    }

    el.hourlyForecast.innerHTML = indices.map(({ time, index }, position) => {
        const [description, icon] = weatherInfo(codes[index]);
        return `
            <div class="hour-card">
                <span class="hour-time">${position === 0 ? "Now" : escapeHTML(timeLabel(time))}</span>
                <span class="hour-icon" title="${escapeHTML(description)}">${icon}</span>
                <strong>${temperature(temperatures[index])}</strong>
                <small>${rain[index] == null ? "Rain —" : `${fmt(rain[index])}% rain`}</small>
            </div>`;
    }).join("");
}

/* -------------------- Daily forecast -------------------- */

function renderDailyForecast(result) {
    const daily = result.daily || {};
    const times = asArray(daily.time);
    const highs = asArray(daily.temperature_2m_max);
    const lows = asArray(daily.temperature_2m_min);
    const codes = asArray(daily.weather_code || daily.weathercode);
    const rain = asArray(daily.precipitation_probability_max);
    const sunrise = asArray(daily.sunrise);
    const sunset = asArray(daily.sunset);

    if (!times.length) {
        el.dailyForecast.innerHTML = '<p class="muted">Daily forecast is unavailable.</p>';
        return;
    }

    el.dailyForecast.innerHTML = times.slice(0, 7).map((day, index) => {
        const [description, icon] = weatherInfo(codes[index]);

        return `
            <div class="day-row">
                <div class="day-name">
                    <strong>${index === 0 ? "Today" : escapeHTML(dayLabel(day))}</strong>
                    <small>${escapeHTML(description)}</small>
                </div>
                <span class="day-icon">${icon}</span>
                <div class="day-rain">${rain[index] == null ? "—" : `💧 ${fmt(rain[index])}%`}</div>
                <div class="day-temperatures">
                    <strong>${temperature(highs[index])}</strong>
                    <span>${temperature(lows[index])}</span>
                </div>
                <div class="day-sun">
                    ${sunrise[index] ? `<small>↑ ${escapeHTML(timeLabel(sunrise[index]))}</small>` : ""}
                    ${sunset[index] ? `<small>↓ ${escapeHTML(timeLabel(sunset[index]))}</small>` : ""}
                </div>
            </div>`;
    }).join("");
}

/* -------------------- Air quality -------------------- */

function aqiCategory(value) {
    const aqi = asNumber(value);

    if (aqi === null) return {
        label: "Unavailable",
        className: "aqi-unknown",
        advice: "Air-quality data is currently unavailable."
    };

    if (aqi <= 50) return {
        label: "Good",
        className: "aqi-good-text",
        advice: "Air quality is generally satisfactory."
    };

    if (aqi <= 100) return {
        label: "Moderate",
        className: "aqi-moderate-text",
        advice: "Unusually sensitive people may wish to limit prolonged outdoor exertion."
    };

    if (aqi <= 150) return {
        label: "Unhealthy for sensitive groups",
        className: "aqi-sensitive-text",
        advice: "Sensitive groups should consider reducing prolonged outdoor exertion."
    };

    if (aqi <= 200) return {
        label: "Unhealthy",
        className: "aqi-unhealthy-text",
        advice: "Consider reducing prolonged outdoor activity."
    };

    if (aqi <= 300) return {
        label: "Very unhealthy",
        className: "aqi-severe-text",
        advice: "Reduce outdoor exertion and follow local health guidance."
    };

    return {
        label: "Hazardous",
        className: "aqi-severe-text",
        advice: "Avoid prolonged outdoor exertion and follow official health advice."
    };
}

function renderAirQuality(air) {
    const data = air && typeof air === "object" ? air : {};
    const current = data.current || {};
    const aqi = valueFrom(current, "us_aqi");
    const euAqi = valueFrom(current, "european_aqi");
    const category = aqiCategory(aqi);

    el.airQualityStatus.textContent = category.label;
    el.airQualityStatus.className = `status-pill ${category.className}`;

    el.airSummary.innerHTML = `
        <div class="air-score ${category.className}">
            <strong>${aqi == null ? "—" : fmt(aqi)}</strong>
            <span>US AQI</span>
        </div>
        <div class="air-summary-copy">
            <h3>${escapeHTML(category.label)}</h3>
            <p>${escapeHTML(category.advice)}</p>
            <small>European AQI: ${euAqi == null ? "—" : fmt(euAqi)}</small>
        </div>`;

    const pollutants = {
        pm25Value: current.pm2_5,
        pm10Value: current.pm10,
        coValue: current.carbon_monoxide,
        no2Value: current.nitrogen_dioxide,
        so2Value: current.sulphur_dioxide,
        o3Value: current.ozone
    };

    Object.entries(pollutants).forEach(([id, value]) => {
        const node = document.getElementById(id);
        if (node) node.textContent = value == null ? "—" : fmt(value, 1);
    });

    const time = current.time;
    el.airDetail.textContent = time
        ? `Latest available measurement: ${time}. Pollutant readings and AQI may vary by location and provider.`
        : "Air quality data may be unavailable for some locations. Follow official local health guidance.";
}

/* -------------------- Map -------------------- */

function initializeMap() {
    if (!window.L || !$("#weatherMap") || state.mapReady) return;

    state.map = L.map("weatherMap", {
        zoomControl: true,
        scrollWheelZoom: false
    }).setView([20, 0], 2);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(state.map);

    state.map.on("click", event => {
        el.latitudeInput.value = event.latlng.lat.toFixed(5);
        el.longitudeInput.value = event.latlng.lng.toFixed(5);
        el.coordinateForm.classList.remove("hidden");
        showToast("Coordinates selected. Click Find weather to load this point.");
    });

    state.mapReady = true;
}

function updateMap(location) {
    if (!state.mapReady || !state.map || !location) return;

    const lat = Number(location.latitude);
    const lon = Number(location.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const position = [lat, lon];
    state.map.flyTo(position, 7, { duration: 0.6 });

    if (state.marker) {
        state.marker.setLatLng(position);
    } else {
        state.marker = L.marker(position).addTo(state.map);
    }

    state.marker.bindPopup(escapeHTML(locationLabel(location))).openPopup();
    el.coordinatesDisplay.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/* -------------------- Favorites -------------------- */

function sameLocation(a, b) {
    if (!a || !b) return false;

    const first = normalizeLocation(a);
    const second = normalizeLocation(b);

    if (first.id !== null && second.id !== null && String(first.id) === String(second.id)) {
        return true;
    }

    return first.name.toLowerCase() === second.name.toLowerCase()
        && first.latitude !== null
        && second.latitude !== null
        && Math.abs(first.latitude - second.latitude) < 0.001
        && Math.abs(first.longitude - second.longitude) < 0.001;
}

function updateFavoriteButton() {
    if (!state.location) {
        el.favoriteButton.textContent = "☆";
        el.favoriteButton.classList.remove("is-favorite");
        return;
    }

    const saved = state.favorites.some(item => sameLocation(item, state.location));
    el.favoriteButton.textContent = saved ? "★" : "☆";
    el.favoriteButton.classList.toggle("is-favorite", saved);
    el.favoriteButton.title = saved ? "Remove from favorites" : "Save this location";
}

async function loadFavorites() {
    try {
        const data = await apiRequest(API.favorites);
        state.favorites = responseItems(data, "favorites", "items", "data");
        renderFavorites();
        updateFavoriteButton();
    } catch (error) {
        el.favoritesList.innerHTML = '<p class="muted">Could not load favorites. Check the server.</p>';
    }
}

function renderFavorites() {
    if (!state.favorites.length) {
        el.favoritesList.innerHTML = '<p class="muted">No saved locations yet. Click ☆ to save a place.</p>';
        return;
    }

    el.favoritesList.innerHTML = state.favorites.map((item, index) => {
        const location = normalizeLocation(item);

        return `
            <div class="saved-row">
                <button type="button" class="saved-location" data-favorite-index="${index}">
                    <span class="saved-location-icon">📍</span>
                    <span>
                        <strong>${escapeHTML(location.name)}</strong>
                        <small>${escapeHTML([location.admin1, location.country].filter(Boolean).join(", "))}</small>
                    </span>
                </button>
                <button type="button" class="remove-saved" data-remove-favorite="${index}" aria-label="Remove favorite">×</button>
            </div>`;
    }).join("");
}

async function toggleFavorite() {
    if (!state.location) {
        showToast("Search for a location first.", "error");
        return;
    }

    const existing = state.favorites.find(item => sameLocation(item, state.location));

    try {
        if (existing) {
            await apiRequest(API.favorites, {
                method: "DELETE",
                body: JSON.stringify({
                    id: existing.id,
                    name: existing.name,
                    latitude: existing.latitude ?? existing.lat,
                    longitude: existing.longitude ?? existing.lon
                })
            });
            showToast("Favorite removed.");
        } else {
            await apiRequest(API.favorites, {
                method: "POST",
                body: JSON.stringify({
                    name: state.location.name,
                    country: state.location.country,
                    country_code: state.location.country_code,
                    admin1: state.location.admin1,
                    latitude: state.location.latitude,
                    longitude: state.location.longitude
                })
            });
            showToast("Location saved to favorites.", "success");
        }

        await loadFavorites();
    } catch (error) {
        showToast(error.message || "Could not update favorite.", "error");
    }
}

/* -------------------- History -------------------- */

async function loadHistory() {
    try {
        const data = await apiRequest(API.history);
        state.history = responseItems(data, "history", "items", "data");
        renderHistory();
    } catch (error) {
        el.historyList.innerHTML = '<p class="muted">Could not load search history.</p>';
    }
}

function renderHistory() {
    if (!state.history.length) {
        el.historyList.innerHTML = '<p class="muted">No recent searches yet.</p>';
        return;
    }

    el.historyList.innerHTML = state.history.slice(0, 10).map((item, index) => {
        const location = normalizeLocation(item);
        return `
            <button type="button" class="history-row" data-history-index="${index}">
                <span class="history-clock">◷</span>
                <span>
                    <strong>${escapeHTML(location.name)}</strong>
                    <small>${escapeHTML([location.admin1, location.country].filter(Boolean).join(", "))}</small>
                </span>
                <span class="saved-arrow">↗</span>
            </button>`;
    }).join("");
}

/* -------------------- Preferences -------------------- */

function applyTheme(dark) {
    state.dark = Boolean(dark);
    document.body.classList.toggle("dark-theme", state.dark);
    el.themeToggle.textContent = state.dark ? "☀" : "☾";
    el.themeToggle.setAttribute(
        "aria-label",
        state.dark ? "Switch to light theme" : "Switch to dark theme"
    );

    try {
        localStorage.setItem("weatherworld-theme", state.dark ? "dark" : "light");
    } catch (_) {}
}

function toggleUnits() {
    state.unit = isFahrenheit() ? "celsius" : "fahrenheit";
    el.unitToggle.textContent = isFahrenheit() ? "°F / °C" : "°C / °F";

    if (state.weather) {
        renderCurrentWeather(state.weather);
        renderHourlyForecast(state.weather);
        renderDailyForecast(state.weather);
    }
}

function restorePreferences() {
    try {
        applyTheme(localStorage.getItem("weatherworld-theme") === "dark");
    } catch (_) {
        applyTheme(false);
    }

    state.unit = "celsius";
}

/* -------------------- Device location -------------------- */

function useCurrentLocation() {
    if (!navigator.geolocation) {
        showToast("Your browser does not support location access.", "error");
        return;
    }

    setLoading(true);

    navigator.geolocation.getCurrentPosition(
        async position => {
            const { latitude, longitude } = position.coords;
            el.latitudeInput.value = latitude;
            el.longitudeInput.value = longitude;
            el.coordinateForm.classList.remove("hidden");

            try {
                await searchByCoordinates(latitude, longitude);
            } finally {
                setLoading(false);
            }
        },
        error => {
            setLoading(false);
            const messages = {
                1: "Location permission was denied. Search by city instead.",
                2: "Your current location could not be determined.",
                3: "Location request timed out. Please try again."
            };
            showToast(messages[error.code] || "Could not access your location.", "error");
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
}

/* -------------------- Health and CSV export -------------------- */

async function checkHealth() {
    try {
        await apiRequest(API.health);
        el.apiStatusDot.classList.add("online");
        el.apiStatusDot.classList.remove("offline");
        el.apiStatusText.textContent = "Connected";
    } catch (_) {
        el.apiStatusDot.classList.remove("online");
        el.apiStatusDot.classList.add("offline");
        el.apiStatusText.textContent = "Unavailable";
    }
}

async function exportHistory() {
    try {
        const response = await fetch(API.export);

        if (!response.ok) {
            let message = "Could not export history.";
            try {
                const data = await response.json();
                message = data.error || message;
            } catch (_) {}
            throw new Error(message);
        }

        const blob = await response.blob();
        const objectURL = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectURL;
        link.download = "weather-history.csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectURL);
        showToast("CSV export downloaded.", "success");
    } catch (error) {
        showToast(error.message || "Export failed.", "error");
    }
}

/* -------------------- Event handlers -------------------- */

function bindEvents() {
    el.searchForm.addEventListener("submit", event => {
        event.preventDefault();
        searchByText(el.locationInput.value);
    });

    el.locationInput.addEventListener("input", autocomplete);

    el.locationInput.addEventListener("keydown", event => {
        if (event.key === "Escape") hideSuggestions();

        if (event.key === "ArrowDown") {
            const first = el.suggestions.querySelector(".suggestion-item");
            if (first) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    el.suggestions.addEventListener("click", async event => {
        const button = event.target.closest("[data-suggestion-index]");
        if (!button) return;

        const location = state.suggestions[Number(button.dataset.suggestionIndex)];
        if (!location) return;

        try {
            await loadWeather(location);
        } catch (_) {}
    });

    document.addEventListener("click", event => {
        if (!event.target.closest(".search-panel")) hideSuggestions();
    });

    el.coordinateToggle.addEventListener("click", () => {
        el.coordinateForm.classList.toggle("hidden");
        if (!el.coordinateForm.classList.contains("hidden")) {
            el.latitudeInput.focus();
        }
    });

    el.coordinateForm.addEventListener("submit", event => {
        event.preventDefault();
        searchByCoordinates(el.latitudeInput.value, el.longitudeInput.value);
    });

    el.currentLocationButton.addEventListener("click", useCurrentLocation);
    el.unitToggle.addEventListener("click", toggleUnits);
    el.themeToggle.addEventListener("click", () => applyTheme(!state.dark));
    el.favoriteButton.addEventListener("click", toggleFavorite);
    el.refreshHistoryButton.addEventListener("click", loadHistory);
    el.exportButton.addEventListener("click", exportHistory);

    el.favoritesList.addEventListener("click", async event => {
        const removeButton = event.target.closest("[data-remove-favorite]");

        if (removeButton) {
            const item = state.favorites[Number(removeButton.dataset.removeFavorite)];
            if (!item) return;

            try {
                await apiRequest(API.favorites, {
                    method: "DELETE",
                    body: JSON.stringify({
                        id: item.id,
                        latitude: item.latitude ?? item.lat,
                        longitude: item.longitude ?? item.lon,
                        name: item.name
                    })
                });
                await loadFavorites();
                showToast("Favorite removed.");
            } catch (error) {
                showToast(error.message || "Could not remove favorite.", "error");
            }
            return;
        }

        const button = event.target.closest("[data-favorite-index]");
        if (!button) return;

        const location = state.favorites[Number(button.dataset.favoriteIndex)];
        if (location) {
            try {
                await loadWeather(location);
            } catch (_) {}
        }
    });

    el.historyList.addEventListener("click", async event => {
        const button = event.target.closest("[data-history-index]");
        if (!button) return;

        const location = state.history[Number(button.dataset.historyIndex)];
        if (!location) return;

        try {
            await loadWeather(location);
        } catch (_) {}
    });
}

/* -------------------- Start dashboard -------------------- */

async function initializeDashboard() {
    restorePreferences();
    initializeMap();
    bindEvents();

    await Promise.all([checkHealth(), loadFavorites(), loadHistory()]);

    const params = new URLSearchParams(window.location.search);
    const city = params.get("city");
    const lat = params.get("latitude");
    const lon = params.get("longitude");

    if (lat !== null && lon !== null) {
        await searchByCoordinates(lat, lon);
    } else if (city) {
        el.locationInput.value = city;
        await searchByText(city);
    }
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
