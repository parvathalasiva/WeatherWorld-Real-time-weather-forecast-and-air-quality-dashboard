
"use strict";

/* ==========================================================
   WEATHERWORLD - COMPLETE UPDATED SCRIPT
   Flask backend + Open-Meteo weather API
   ========================================================== */

const $ = (id) => document.getElementById(id);

const API = {
    health: "/api/health",
    providerHealth: "/api/provider-health",
    search: "/api/search",
    weather: "/api/weather",
    airQuality: "/api/air-quality",
    favorites: "/api/favorites",
    history: "/api/history",
    export: "/api/history/export"
};

const DEFAULT_LOCATION = {
    name: "Kadapa",
    country: "India",
    admin1: "Andhra Pradesh",
    latitude: 14.46795,
    longitude: 78.82346,
    timezone: "Asia/Kolkata"
};

const WEATHER_CODES = {
    0: ["Clear sky", "☀️"],
    1: ["Mainly clear", "🌤️"],
    2: ["Partly cloudy", "⛅"],
    3: ["Overcast", "☁️"],
    45: ["Fog", "🌫️"],
    48: ["Rime fog", "🌫️"],
    51: ["Light drizzle", "🌦️"],
    53: ["Moderate drizzle", "🌦️"],
    55: ["Dense drizzle", "🌧️"],
    56: ["Light freezing drizzle", "🌧️"],
    57: ["Dense freezing drizzle", "🌧️"],
    61: ["Slight rain", "🌦️"],
    63: ["Moderate rain", "🌧️"],
    65: ["Heavy rain", "🌧️"],
    66: ["Light freezing rain", "🌧️"],
    67: ["Heavy freezing rain", "🌧️"],
    71: ["Slight snowfall", "🌨️"],
    73: ["Moderate snowfall", "🌨️"],
    75: ["Heavy snowfall", "❄️"],
    77: ["Snow grains", "🌨️"],
    80: ["Slight rain showers", "🌦️"],
    81: ["Moderate rain showers", "🌧️"],
    82: ["Heavy rain showers", "⛈️"],
    85: ["Light snow showers", "🌨️"],
    86: ["Heavy snow showers", "❄️"],
    95: ["Thunderstorm", "⛈️"],
    96: ["Thunderstorm with hail", "⛈️"],
    99: ["Severe thunderstorm with hail", "⛈️"]
};

const state = {
    location: { ...DEFAULT_LOCATION },
    weatherData: null,
    airQualityData: null,
    useFahrenheit: false,
    darkMode: false,
    favorites: [],
    history: [],
    searchResults: [],
    searchTimer: null,
    searchRequestId: 0,
    weatherRequestId: 0,
    searchController: null,
    weatherController: null,
    map: null,
    mapMarker: null
};

/* ==========================================================
   GENERAL HELPERS
   ========================================================== */

function getFirstElement(ids) {
    for (const id of ids) {
        const element = $(id);
        if (element) return element;
    }
    return null;
}

function setText(ids, value) {
    const element = Array.isArray(ids)
        ? getFirstElement(ids)
        : $(ids);

    if (element) {
        element.textContent = value == null ? "" : String(value);
    }
}

function setHTML(id, value) {
    const element = $(id);
    if (element) element.innerHTML = value;
}

function showElement(element) {
    if (element) element.classList.remove("hidden");
}

function hideElement(element) {
    if (element) element.classList.add("hidden");
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatNumber(value, decimals = 0) {
    const number = finiteNumber(value);

    if (number === null) return "—";

    return number.toLocaleString(undefined, {
        maximumFractionDigits: decimals
    });
}

function formatMetric(value, suffix = "", decimals = 0) {
    const number = finiteNumber(value);

    return number === null
        ? "—"
        : `${formatNumber(number, decimals)}${suffix}`;
}

function localLocationName(location = state.location) {
    const values = [
        location.name,
        location.admin1,
        location.country
    ].filter(Boolean);

    return values.filter(
        (value, index) => values.indexOf(value) === index
    ).join(", ");
}

function getWeatherInfo(code) {
    return WEATHER_CODES[Number(code)] || ["Unknown conditions", "🌍"];
}

function temperatureUnit() {
    return state.useFahrenheit ? "°F" : "°C";
}

function temperatureValue(value) {
    const number = finiteNumber(value);

    if (number === null) return "—";

    const converted = state.useFahrenheit
        ? number * 9 / 5 + 32
        : number;

    return `${Math.round(converted)}°`;
}

function windSpeedValue(value) {
    const number = finiteNumber(value);

    if (number === null) return "—";

    const converted = state.useFahrenheit
        ? number / 1.609344
        : number;

    return `${formatNumber(converted, 1)} ${
        state.useFahrenheit ? "mph" : "km/h"
    }`;
}

function windDirection(value) {
    const degrees = finiteNumber(value);

    if (degrees === null) return "—";

    const directions = [
        "N", "NNE", "NE", "ENE",
        "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW",
        "W", "WNW", "NW", "NNW"
    ];

    return directions[Math.round(degrees / 22.5) % 16];
}

function formatTime(value) {
    if (!value) return "—";

    const match = String(value).match(/T(\d{2}:\d{2})/);
    return match ? match[1] : String(value);
}

function formatDay(value) {
    if (!value) return "—";

    const date = new Date(`${value}T12:00:00`);

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric"
    });
}

function formatDateTime(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

function showLoading(show) {
    const overlay = $("loadingOverlay");
    if (overlay) overlay.classList.toggle("hidden", !show);

    document.body.classList.toggle("weather-loading", show);
}

function showError(message) {
    const banner = $("errorBanner");

    if (banner) {
        banner.textContent = message;
        showElement(banner);
    } else {
        console.error("WeatherWorld:", message);
    }

    hideElement($("successBanner"));
}

function showSuccess(message) {
    const banner = $("successBanner");

    if (banner) {
        banner.textContent = message;
        showElement(banner);
    } else {
        console.info("WeatherWorld:", message);
    }

    hideElement($("errorBanner"));
}

function clearMessages() {
    hideElement($("errorBanner"));
    hideElement($("successBanner"));
}

function setConnectionStatus(online, message) {
    setText(["connectionText", "topStatusText"], message);

    const dot = getFirstElement([
        "sidebarStatusDot",
        "topStatusDot"
    ]);

    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

function setProviderStatus(online, message) {
    setText(["providerStatusText", "weatherStatus"], message);

    const dot = $("providerStatusDot");

    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

/* ==========================================================
   API REQUEST HELPER
   ========================================================== */

async function apiFetch(url, options = {}) {
    const headers = {
        Accept: "application/json",
        ...(options.body
            ? { "Content-Type": "application/json" }
            : {}),
        ...(options.headers || {})
    };

    let response;

    try {
        response = await fetch(url, {
            ...options,
            headers
        });
    } catch (error) {
        if (error.name === "AbortError") throw error;

        throw new Error(
            "Cannot connect to Flask. Make sure app.py is running."
        );
    }

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            `Invalid server response. HTTP ${response.status}.`
        );
    }

    if (!response.ok) {
        const error = new Error(
            data.error || `Request failed: HTTP ${response.status}.`
        );

        error.status = response.status;
        throw error;
    }

    return data;
}

function locationQuery(location) {
    const params = new URLSearchParams({
        name: location.name || "Selected location",
        country: location.country || "",
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        timezone: location.timezone || "auto"
    });

    return params.toString();
}

/* ==========================================================
   LOCATION SEARCH
   ========================================================== */

async function searchLocations(query) {
    const text = query.trim();

    if (text.length < 2) {
        hideSearchResults();
        return;
    }

    const requestId = ++state.searchRequestId;

    if (state.searchController) {
        state.searchController.abort();
    }

    const controller = new AbortController();
    state.searchController = controller;

    try {
        const data = await apiFetch(
            `${API.search}?q=${encodeURIComponent(text)}`,
            { signal: controller.signal }
        );

        if (requestId !== state.searchRequestId) return;

        state.searchResults = Array.isArray(data.results)
            ? data.results
            : [];

        renderSearchResults(state.searchResults);

    } catch (error) {
        if (error.name === "AbortError") return;

        console.error("Search error:", error);
        hideSearchResults();
    }
}

function renderSearchResults(results) {
    const container = $("searchResults");

    if (!container) return;

    container.replaceChildren();

    if (!results.length) {
        const empty = document.createElement("div");
        empty.className = "search-result-empty";
        empty.textContent = "No matching locations found.";

        container.appendChild(empty);
        showElement(container);
        return;
    }

    results.forEach((place, index) => {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "search-result";
        button.dataset.searchIndex = String(index);

        const title = document.createElement("strong");
        title.textContent = place.name || "Unknown location";

        const subtitle = document.createElement("small");
        subtitle.textContent = [
            place.admin1,
            place.country
        ].filter(Boolean).join(", ");

        button.append(title, subtitle);
        container.appendChild(button);
    });

    showElement(container);
}

function hideSearchResults() {
    hideElement($("searchResults"));
}

function normalizeLocation(place) {
    return {
        name: place.name || "Selected location",
        country: place.country || "",
        admin1: place.admin1 || "",
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        timezone: place.timezone || "auto",
        id: place.id
    };
}

async function selectSearchResult(index) {
    const place = state.searchResults[index];

    if (!place) return;

    const location = normalizeLocation(place);

    const input = $("locationInput");
    if (input) input.value = localLocationName(location);

    hideSearchResults();

    await loadWeather(location);
}

async function submitSearch(query) {
    const text = query.trim();

    if (!text) {
        showError("Enter a city, town, village, or country.");
        return;
    }

    clearMessages();

    try {
        const data = await apiFetch(
            `${API.search}?q=${encodeURIComponent(text)}`
        );

        const results = Array.isArray(data.results)
            ? data.results
            : [];

        if (!results.length) {
            showError(
                "Location not found. Try adding the state or country."
            );
            return;
        }

        state.searchResults = results;

        const normalizedQuery = text
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        const exactMatch = results.find((place) => {
            const fullName = localLocationName(place).toLowerCase();

            return fullName === normalizedQuery ||
                String(place.name || "").toLowerCase() === normalizedQuery;
        });

        const selected = exactMatch || results[0];

        await loadWeather(normalizeLocation(selected));

    } catch (error) {
        showError(error.message);
    }
}

/* ==========================================================
   WEATHER FETCHING
   ========================================================== */

async function loadWeather(location, options = {}) {
    const latitude = finiteNumber(location?.latitude);
    const longitude = finiteNumber(location?.longitude);

    if (
        latitude === null ||
        longitude === null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        showError("Invalid location coordinates.");
        return;
    }

    const requestId = ++state.weatherRequestId;

    if (state.weatherController) {
        state.weatherController.abort();
    }

    const controller = new AbortController();
    state.weatherController = controller;

    /*
     * Set the selected location BEFORE making the request.
     * This prevents the main card from retaining Kadapa when
     * the user has selected Nellore or another location.
     */
    state.location = {
        ...location,
        name: location.name || "Selected location",
        country: location.country || "",
        admin1: location.admin1 || "",
        latitude,
        longitude,
        timezone: location.timezone || "auto"
    };

    clearMessages();
    updateLocationUI();
    updateFavoriteButton();
    showLoading(true);

    try {
        const data = await apiFetch(
            `${API.weather}?${locationQuery(state.location)}`,
            { signal: controller.signal }
        );

        // Ignore any older response after a newer search.
        if (requestId !== state.weatherRequestId) return;

        if (!data || !data.current) {
            throw new Error(
                "Weather data is missing for the selected location."
            );
        }

        state.weatherData = data;

        /*
         * Keep the selected search location authoritative.
         * Do not replace it with the backend's default location.
         */
        renderWeather(data, state.location);

        setProviderStatus(true, "Weather service available");

        if (data.cached) {
            showError(
                "Showing cached weather because the weather provider is temporarily unavailable."
            );
        } else if (!options.silent) {
            showSuccess(
                `Weather loaded for ${localLocationName(state.location)}.`
            );
        }

        updateMapLocation();

        // Load secondary sections without blocking the main weather card.
        loadAirQuality(state.location, requestId);
        loadFavorites();
        loadHistory();

    } catch (error) {
        if (error.name === "AbortError") return;
        if (requestId !== state.weatherRequestId) return;

        console.error("Weather loading failed:", error);

        setProviderStatus(false, "Weather unavailable");
        showError(error.message || "Unable to load weather.");

    } finally {
        if (requestId === state.weatherRequestId) {
            showLoading(false);
        }
    }
}

/* ==========================================================
   RENDER THE COMPLETE WEATHER RESPONSE
   ========================================================== */

function renderWeather(data, selectedLocation = state.location) {
    if (!data || !data.current) {
        showError("No weather information was returned.");
        return;
    }

    state.weatherData = data;

    // Preserve the actual place chosen in the search.
    state.location = {
        ...state.location,
        ...selectedLocation,
        latitude: Number(selectedLocation.latitude),
        longitude: Number(selectedLocation.longitude)
    };

    updateLocationUI();

    const current = data.current;
    const daily = data.daily || {};
    const hourly = data.hourly || {};

    renderCurrent(current, daily);
    renderHourly(hourly);
    renderDaily(daily);
    updateTemperatureUnitLabels();
    updateFavoriteButton();
    updateMapLocation();
}

function updateLocationUI() {
    const name = localLocationName(state.location);

    /*
     * Support multiple common IDs so that the visible location
     * title is updated even if the HTML uses a different name.
     */
    setText([
        "locationName",
        "currentLocationName",
        "weatherLocation",
        "locationLabel",
        "currentCity",
        "weatherCity",
        "currentLocation",
        "selectedLocationName",
        "weatherLocationName"
    ], name);

    setText([
        "locationCountry",
        "currentCountry"
    ], state.location.country || "");

    setText([
        "currentLocalTime",
        "localTime"
    ], getLocationLocalTime());

    const pageTitle = $("pageTitle");

    if (pageTitle) {
        pageTitle.textContent = `Weather in ${state.location.name} | WeatherWorld`;
    }
}

/* ==========================================================
   CURRENT WEATHER CARD
   ========================================================== */

function renderCurrent(current, daily = {}) {
    const info = getWeatherInfo(current.weather_code);

    setText([
        "currentTemperature",
        "temperatureValue",
        "currentTemp",
        "temperature"
    ], temperatureValue(current.temperature_2m));

    setText([
        "currentUnit",
        "temperatureUnit"
    ], temperatureUnit());

    setText([
        "weatherDescription",
        "currentDescription",
        "weatherCondition",
        "conditionText"
    ], info[0]);

    setText([
        "weatherIcon",
        "currentWeatherIcon"
    ], info[1]);

    setText([
        "feelsLike",
        "feelsLikeValue"
    ], temperatureValue(current.apparent_temperature));

    setText([
        "humidityValue",
        "humidity"
    ], formatMetric(current.relative_humidity_2m, "%"));

    setText([
        "windSpeedValue",
        "windSpeed"
    ], windSpeedValue(current.wind_speed_10m));

    setText([
        "windDirectionValue",
        "windDirection"
    ], windDirection(current.wind_direction_10m));

    setText([
        "pressureValue",
        "pressure"
    ], formatMetric(current.surface_pressure, " hPa", 1));

    setText([
        "cloudCoverValue",
        "cloudCover"
    ], formatMetric(current.cloud_cover, "%"));

    setText([
        "precipitationValue",
        "precipitation"
    ], formatMetric(current.precipitation, " mm", 1));

    setText([
        "uvIndexValue",
        "uvIndex"
    ], formatNumber(daily.uv_index_max?.[0], 1));

    setText([
        "sunriseValue",
        "sunrise"
    ], formatTime(daily.sunrise?.[0]));

    setText([
        "sunsetValue",
        "sunset"
    ], formatTime(daily.sunset?.[0]));

    renderMetricCards(current, daily);
}

function getLocationLocalTime() {
    const timezone = state.weatherData?.timezone ||
        state.location.timezone;

    try {
        return new Intl.DateTimeFormat([], {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: timezone && timezone !== "auto"
                ? timezone
                : undefined
        }).format(new Date());
    } catch {
        return new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
        });
    }
}

function renderMetricCards(current, daily = {}) {
    const container = $("weatherMetrics");

    if (!container) return;

    const metrics = [
        {
            label: "Humidity",
            value: formatMetric(current.relative_humidity_2m, "%"),
            icon: "💧"
        },
        {
            label: "Wind speed",
            value: windSpeedValue(current.wind_speed_10m),
            icon: "💨"
        },
        {
            label: "Wind direction",
            value: windDirection(current.wind_direction_10m),
            icon: "🧭"
        },
        {
            label: "Pressure",
            value: formatMetric(current.surface_pressure, " hPa", 1),
            icon: "🌡️"
        },
        {
            label: "Cloud cover",
            value: formatMetric(current.cloud_cover, "%"),
            icon: "☁️"
        },
        {
            label: "UV index",
            value: formatNumber(daily.uv_index_max?.[0], 1),
            icon: "☀️"
        }
    ];

    container.replaceChildren();

    metrics.forEach((metric) => {
        const card = document.createElement("div");
        card.className = "metric-card";

        const icon = document.createElement("span");
        icon.className = "metric-icon";
        icon.textContent = metric.icon;

        const details = document.createElement("div");

        const label = document.createElement("small");
        label.textContent = metric.label;

        const value = document.createElement("strong");
        value.textContent = metric.value;

        details.append(label, value);
        card.append(icon, details);
        container.appendChild(card);
    });
}

/* ==========================================================
   HOURLY FORECAST
   ========================================================== */

function renderHourly(hourly = {}) {
    const container = $("hourlyForecast");

    if (!container) return;

    container.replaceChildren();

    const times = hourly.time || [];
    const temperatures = hourly.temperature_2m || [];
    const codes = hourly.weather_code || [];
    const humidity = hourly.relative_humidity_2m || [];
    const rain = hourly.precipitation_probability || [];
    const wind = hourly.wind_speed_10m || [];

    if (!times.length) {
        container.textContent = "Hourly forecast is unavailable.";
        return;
    }

    const now = Date.now();

    let startIndex = times.findIndex((time) => {
        const date = new Date(time);
        return !Number.isNaN(date.getTime()) &&
            date.getTime() >= now - 3600000;
    });

    if (startIndex < 0) startIndex = 0;

    for (
        let i = startIndex;
        i < Math.min(startIndex + 24, times.length);
        i++
    ) {
        const card = document.createElement("article");
        card.className = "forecast-card hourly-card";

        const time = document.createElement("small");
        time.textContent = formatTime(times[i]);

        const info = getWeatherInfo(codes[i]);

        const icon = document.createElement("div");
        icon.className = "forecast-icon";
        icon.textContent = info[1];

        const temperature = document.createElement("strong");
        temperature.textContent =
            `${temperatureValue(temperatures[i])}${temperatureUnit()}`;

        const description = document.createElement("span");
        description.textContent = info[0];

        const rainText = document.createElement("small");
        rainText.textContent =
            `Rain: ${formatMetric(rain[i], "%")}`;

        const details = document.createElement("small");
        details.textContent =
            `Humidity: ${formatMetric(humidity[i], "%")} · Wind: ${windSpeedValue(wind[i])}`;

        card.append(
            time,
            icon,
            temperature,
            description,
            rainText,
            details
        );

        container.appendChild(card);
    }
}

/* ==========================================================
   7-DAY FORECAST
   ========================================================== */

function renderDaily(daily = {}) {
    const container = $("dailyForecast");

    if (!container) return;

    container.replaceChildren();

    const times = daily.time || [];
    const codes = daily.weather_code || [];
    const highs = daily.temperature_2m_max || [];
    const lows = daily.temperature_2m_min || [];
    const rain = daily.precipitation_probability_max || [];
    const uv = daily.uv_index_max || [];

    if (!times.length) {
        container.textContent = "7-day forecast is unavailable.";
        return;
    }

    times.forEach((date, index) => {
        const card = document.createElement("article");
        card.className = "forecast-card daily-card";

        const day = document.createElement("strong");
        day.textContent = formatDay(date);

        const info = getWeatherInfo(codes[index]);

        const icon = document.createElement("div");
        icon.className = "forecast-icon";
        icon.textContent = info[1];

        const description = document.createElement("span");
        description.textContent = info[0];

        const temperature = document.createElement("strong");
        temperature.textContent =
            `${temperatureValue(highs[index])}${temperatureUnit()} / ` +
            `${temperatureValue(lows[index])}${temperatureUnit()}`;

        const rainText = document.createElement("small");
        rainText.textContent =
            `Rain chance: ${formatMetric(rain[index], "%")}`;

        const uvText = document.createElement("small");
        uvText.textContent = `UV max: ${formatNumber(uv[index], 1)}`;

        card.append(
            day,
            icon,
            description,
            temperature,
            rainText,
            uvText
        );

        container.appendChild(card);
    });
}

/* ==========================================================
   AIR QUALITY
   ========================================================== */

async function loadAirQuality(location, weatherRequestId) {
    try {
        const data = await apiFetch(
            `${API.airQuality}?${locationQuery(location)}`
        );

        if (weatherRequestId !== state.weatherRequestId) return;

        state.airQualityData = data;

        renderAirQuality(data.current || data);

    } catch (error) {
        if (weatherRequestId !== state.weatherRequestId) return;

        console.warn("Air quality unavailable:", error.message);
        renderAirQualityUnavailable();
    }
}

function renderAirQuality(current = {}) {
    const aqi = finiteNumber(current.us_aqi);
    const europeanAqi = finiteNumber(current.european_aqi);

    setText([
        "aqiValue",
        "airQualityIndex",
        "usAqi"
    ], aqi === null ? "—" : Math.round(aqi));

    setText([
        "europeanAqiValue",
        "europeanAqi"
    ], europeanAqi === null ? "—" : Math.round(europeanAqi));

    setText([
        "pm25Value",
        "pm25"
    ], formatMetric(current.pm2_5, " µg/m³", 1));

    setText([
        "pm10Value",
        "pm10"
    ], formatMetric(current.pm10, " µg/m³", 1));

    setText([
        "ozoneValue",
        "ozone"
    ], formatMetric(current.ozone, " µg/m³", 1));

    setText([
        "nitrogenDioxideValue",
        "nitrogenDioxide"
    ], formatMetric(current.nitrogen_dioxide, " µg/m³", 1));

    setText([
        "airQualityLabel",
        "aqiDescription"
    ], describeAQI(aqi));
}

function describeAQI(aqi) {
    if (aqi === null) return "Air quality unavailable";
    if (aqi <= 50) return "Good";
    if (aqi <= 100) return "Moderate";
    if (aqi <= 150) return "Unhealthy for sensitive groups";
    if (aqi <= 200) return "Unhealthy";
    if (aqi <= 300) return "Very unhealthy";
    return "Hazardous";
}

function renderAirQualityUnavailable() {
    const ids = [
        "aqiValue", "airQualityIndex", "usAqi",
        "europeanAqiValue", "europeanAqi",
        "pm25Value", "pm25", "pm10Value", "pm10",
        "ozoneValue", "ozone",
        "nitrogenDioxideValue", "nitrogenDioxide"
    ];

    ids.forEach((id) => setText(id, "—"));

    setText(
        ["airQualityLabel", "aqiDescription"],
        "Air quality unavailable"
    );
}

/* ==========================================================
   FAVORITES
   ========================================================== */

async function loadFavorites() {
    try {
        const data = await apiFetch(API.favorites);

        state.favorites = Array.isArray(data.results)
            ? data.results
            : [];

        renderFavorites();
        updateFavoriteButton();

    } catch (error) {
        console.warn("Could not load favorites:", error.message);
    }
}

function renderFavorites() {
    const container = $("favoritesList");

    if (!container) return;

    container.replaceChildren();

    if (!state.favorites.length) {
        const empty = document.createElement("p");
        empty.className = "muted small-text";
        empty.textContent = "Your saved locations will appear here.";
        container.appendChild(empty);
        return;
    }

    state.favorites.forEach((favorite) => {
        const row = document.createElement("div");
        row.className = "favorite-item";

        const select = document.createElement("button");
        select.type = "button";
        select.className = "favorite-select";
        select.dataset.favoriteId = String(favorite.id);
        select.textContent = localLocationName(favorite);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "favorite-remove";
        remove.dataset.removeFavorite = String(favorite.id);
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove favorite");

        row.append(select, remove);
        container.appendChild(row);
    });
}

function currentFavorite() {
    return state.favorites.find((favorite) =>
        Math.abs(Number(favorite.latitude) - state.location.latitude) < 0.0001 &&
        Math.abs(Number(favorite.longitude) - state.location.longitude) < 0.0001
    );
}

function updateFavoriteButton() {
    const button = $("favoriteToggle");

    if (!button) return;

    const saved = Boolean(currentFavorite());

    button.textContent = saved ? "★ Saved" : "☆ Add favorite";
    button.setAttribute("aria-pressed", String(saved));
}

async function toggleFavorite() {
    try {
        const favorite = currentFavorite();

        if (favorite) {
            await removeFavorite(favorite.id);
            return;
        }

        await apiFetch(API.favorites, {
            method: "POST",
            body: JSON.stringify(state.location)
        });

        await loadFavorites();
        showSuccess("Location added to favorites.");

    } catch (error) {
        showError(error.message);
    }
}

async function removeFavorite(id) {
    try {
        await apiFetch(
            `${API.favorites}/${encodeURIComponent(id)}`,
            { method: "DELETE" }
        );

        await loadFavorites();
        showSuccess("Favorite removed.");

    } catch (error) {
        showError(error.message);
    }
}

/* ==========================================================
   RECENT SEARCH HISTORY
   ========================================================== */

async function loadHistory() {
    try {
        const data = await apiFetch(API.history);

        state.history = Array.isArray(data.results)
            ? data.results
            : [];

        renderHistory();

    } catch (error) {
        console.warn("Could not load history:", error.message);
    }
}

function renderHistory() {
    const container = $("historyList");

    if (!container) return;

    container.replaceChildren();

    if (!state.history.length) {
        const empty = document.createElement("p");
        empty.className = "muted small-text";
        empty.textContent = "Your recent searches will appear here.";
        container.appendChild(empty);
        return;
    }

    state.history.forEach((item) => {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "history-item";
        button.dataset.historyId = String(item.id);

        const name = document.createElement("span");
        name.textContent = localLocationName(item);

        const date = document.createElement("small");
        date.textContent = formatDateTime(item.searched_at);

        button.append(name, date);
        container.appendChild(button);
    });
}

function exportHistory() {
    window.location.assign(API.export);
}

/* ==========================================================
   UNITS AND THEME
   ========================================================== */

function updateTemperatureUnitLabels() {
    const unit = temperatureUnit();

    document.querySelectorAll("[data-temperature-unit]").forEach(
        (element) => {
            element.textContent = unit;
        }
    );

    const button = $("unitToggle");

    if (button) {
        button.textContent = state.useFahrenheit
            ? "Switch to °C"
            : "Switch to °F";
    }
}

function toggleUnits() {
    state.useFahrenheit = !state.useFahrenheit;

    updateTemperatureUnitLabels();

    if (state.weatherData?.current) {
        renderCurrent(
            state.weatherData.current,
            state.weatherData.daily || {}
        );

        renderHourly(state.weatherData.hourly || {});
        renderDaily(state.weatherData.daily || {});
    }
}

function applyTheme() {
    document.body.classList.toggle("dark-mode", state.darkMode);

    document.documentElement.dataset.theme =
        state.darkMode ? "dark" : "light";

    const button = $("themeToggle");

    if (button) {
        button.textContent = state.darkMode ? "☀" : "☾";
        button.title = state.darkMode ? "Light mode" : "Dark mode";
        button.setAttribute(
            "aria-label",
            state.darkMode ? "Switch to light mode" : "Switch to dark mode"
        );
    }

    if (state.map) {
        window.setTimeout(() => state.map?.invalidateSize(), 100);
    }
}

function toggleTheme() {
    state.darkMode = !state.darkMode;
    applyTheme();
}

/* ==========================================================
   CURRENT DEVICE LOCATION
   ========================================================== */

function useBrowserLocation() {
    if (!navigator.geolocation) {
        showError("Your browser does not support geolocation.");
        return;
    }

    clearMessages();
    showLoading(true);

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            showLoading(false);

            await loadWeather({
                name: "My location",
                country: "",
                admin1: "",
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                timezone: "auto"
            });
        },
        (error) => {
            showLoading(false);

            const messages = {
                1: "Location permission denied. Allow location access in your browser.",
                2: "Your current location could not be determined.",
                3: "Location request timed out. Try again."
            };

            showError(
                messages[error.code] ||
                "Unable to access your current location."
            );
        },
        {
            enableHighAccuracy: false,
            timeout: 12000,
            maximumAge: 300000
        }
    );
}

function searchCoordinates() {
    const value = window.prompt(
        "Enter latitude, longitude.\nExample: 14.46795, 78.82346"
    );

    if (value === null) return;

    const parts = value.split(",").map((part) => part.trim());

    if (parts.length !== 2) {
        showError("Enter coordinates in latitude, longitude format.");
        return;
    }

    const latitude = finiteNumber(parts[0]);
    const longitude = finiteNumber(parts[1]);

    if (
        latitude === null ||
        longitude === null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        showError("Invalid latitude or longitude.");
        return;
    }

    loadWeather({
        name: "Selected coordinates",
        country: "",
        admin1: "",
        latitude,
        longitude,
        timezone: "auto"
    });
}

/* ==========================================================
   WEATHER MAP - REQUIRES LEAFLET IN HTML
   ========================================================== */

function initializeMap() {
    const container = $("weatherMap");

    if (!container || typeof L === "undefined") return;

    try {
        state.map = L.map(container).setView(
            [state.location.latitude, state.location.longitude],
            7
        );

        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                maxZoom: 19,
                attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            }
        ).addTo(state.map);

        state.mapMarker = L.marker([
            state.location.latitude,
            state.location.longitude
        ]).addTo(state.map);

        state.mapMarker.bindPopup(localLocationName(state.location));

        state.map.on("click", (event) => {
            loadWeather({
                name: "Map selection",
                country: "",
                admin1: "",
                latitude: Number(event.latlng.lat.toFixed(5)),
                longitude: Number(event.latlng.lng.toFixed(5)),
                timezone: "auto"
            });
        });

        window.setTimeout(
            () => state.map?.invalidateSize(),
            300
        );

    } catch (error) {
        console.error("Map initialization failed:", error);
    }
}

function updateMapLocation() {
    if (!state.map || !state.mapMarker) return;

    const position = [
        state.location.latitude,
        state.location.longitude
    ];

    state.mapMarker.setLatLng(position);
    state.mapMarker.setPopupContent(localLocationName(state.location));

    state.map.setView(
        position,
        Math.max(state.map.getZoom(), 7)
    );

    window.setTimeout(
        () => state.map?.invalidateSize(),
        100
    );
}

/* ==========================================================
   HEALTH CHECKS
   ========================================================== */

async function checkProviderHealth() {
    try {
        const data = await apiFetch(API.providerHealth);

        if (data.status === "cooldown") {
            setProviderStatus(
                false,
                `Provider cooling down (${data.retry_after_seconds || 0}s)`
            );
        } else {
            setProviderStatus(true, "Weather service available");
        }

    } catch (error) {
        setProviderStatus(false, "Weather service status unavailable");
        console.warn(error.message);
    }
}

/* ==========================================================
   EVENT LISTENERS
   ========================================================== */

function attachEvents() {
    const searchForm = $("searchForm");
    const input = $("locationInput");
    const results = $("searchResults");

    searchForm?.addEventListener("submit", async (event) => {
        event.preventDefault();

        hideSearchResults();

        await submitSearch(input?.value || "");
    });

    input?.addEventListener("input", () => {
        window.clearTimeout(state.searchTimer);

        const query = input.value.trim();

        if (query.length < 2) {
            hideSearchResults();
            return;
        }

        state.searchTimer = window.setTimeout(
            () => searchLocations(query),
            400
        );
    });

    results?.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-search-index]");

        if (!button) return;

        await selectSearchResult(
            Number(button.dataset.searchIndex)
        );
    });

    input?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            hideSearchResults();
        }

        if (event.key === "ArrowDown") {
            results?.querySelector("button")?.focus();
        }

        if (
            event.key === "Enter" &&
            !event.shiftKey
        ) {
            event.preventDefault();
            searchForm?.requestSubmit();
        }
    });

    document.addEventListener("click", (event) => {
        if (
            results &&
            !results.contains(event.target) &&
            !searchForm?.contains(event.target)
        ) {
            hideSearchResults();
        }
    });

    $("useLocationButton")?.addEventListener(
        "click",
        useBrowserLocation
    );

    $("coordinateButton")?.addEventListener(
        "click",
        searchCoordinates
    );

    $("favoriteToggle")?.addEventListener(
        "click",
        toggleFavorite
    );

    $("unitToggle")?.addEventListener(
        "click",
        toggleUnits
    );

    $("themeToggle")?.addEventListener(
        "click",
        toggleTheme
    );

    $("exportHistory")?.addEventListener(
        "click",
        exportHistory
    );

    $("exportHistoryButton")?.addEventListener(
        "click",
        exportHistory
    );

    $("refreshHistory")?.addEventListener("click", async () => {
        await loadHistory();
        showSuccess("Search history refreshed.");
    });

    $("favoritesList")?.addEventListener("click", async (event) => {
        const removeButton = event.target.closest(
            "[data-remove-favorite]"
        );

        if (removeButton) {
            await removeFavorite(
                removeButton.dataset.removeFavorite
            );
            return;
        }

        const selectButton = event.target.closest(
            "[data-favorite-id]"
        );

        if (!selectButton) return;

        const favorite = state.favorites.find(
            (item) =>
                String(item.id) === selectButton.dataset.favoriteId
        );

        if (favorite) {
            await loadWeather(favorite);
        }
    });

    $("historyList")?.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-history-id]");

        if (!button) return;

        const item = state.history.find(
            (entry) =>
                String(entry.id) === button.dataset.historyId
        );

        if (item) {
            await loadWeather(item);
        }
    });

    document.querySelectorAll(".nav-link").forEach((link) => {
        link.addEventListener("click", () => {
            document.querySelectorAll(".nav-link").forEach((item) => {
                item.classList.remove("active");
            });

            link.classList.add("active");

            if (
                link.getAttribute("href") === "#mapSection" ||
                link.getAttribute("href") === "#weatherMap"
            ) {
                window.setTimeout(
                    () => state.map?.invalidateSize(),
                    150
                );
            }

            document.body.classList.remove("sidebar-open");
        });
    });

    $("sidebarToggle")?.addEventListener("click", () => {
        document.body.classList.toggle("sidebar-open");
    });
}

/* ==========================================================
   INITIALIZE APPLICATION
   ========================================================== */

async function initializeApp() {
    attachEvents();
    applyTheme();
    updateTemperatureUnitLabels();
    initializeMap();

    try {
        const health = await apiFetch(API.health);

        setConnectionStatus(
            health.status === "ok",
            health.status === "ok" ? "Connected" : "Backend unavailable"
        );

    } catch (error) {
        setConnectionStatus(false, "Backend unavailable");

        showError(
            "Cannot connect to Flask. Run python app.py in your terminal."
        );

        console.error("Backend health check failed:", error);
        return;
    }

    await checkProviderHealth();

    await Promise.allSettled([
        loadFavorites(),
        loadHistory()
    ]);

    // Load the default city only when the page starts.
    await loadWeather(DEFAULT_LOCATION, { silent: true });

    window.setTimeout(
        () => state.map?.invalidateSize(),
        400
    );
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeApp,
        { once: true }
    );
} else {
    initializeApp();
}
